import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ConditionCtx,
  ArtifactRecord,
} from "tado";
import { basename, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { loadConfig } from "../_shared/mt-plan-init-config";
// NOTE(ADR-0019): Step import は StepDef のみに限定する方針を grill で合意済み。
// mt-review-diff が敵対的検証の単一 SoT であり、mt-plan-run は StepDef 定義のみを
// 直接 import して再利用する。純粋関数・定数 (parseEffortArgs 等) は _shared/mt-review-helpers.ts
// が SoT であり、Step 以外の import は _shared 経由に限定するのが理想だが、今回は seam 漏洩を
// 許容し、次回計画で _shared への集約を完了する。
// TODO(next-plan): _shared への集約を検討 (findArtifactText 等ヘルパも含む)
import {
  resolveEffortStep,
  collectContextStep,
  runReviewersStep,
  publishFindingsStep,
  awaitHumanReviewStep,
  collectVerdictStep,
} from "../mt-review-diff/index.ts";
import {
  parseEffortArgs,
  validateFindingsJson,
  validateVerdictJson,
  FINDINGS_KEY as REVIEW_FINDINGS_KEY,
  VERDICT_KEY as REVIEW_VERDICT_KEY,
  EFFORT_KEY as REVIEW_EFFORT_KEY,
  HUNK_CHECK_KEY,
} from "../_shared/mt-review-helpers.ts";

type JsonRecord = Record<string, unknown>;

interface HunkBlockingThread {
  id?: string;
  file?: string;
  line?: number | { start: number; end: number } | null;
  taxonomy?: string;
  body: string;
  replies?: string[];
}

interface HunkCheckOutput {
  passes: boolean;
  blocking_threads: HunkBlockingThread[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readSessionFile(sessionDir: string, fileName: string): string | undefined {
  try {
    return fs.readFileSync(join(sessionDir, fileName), "utf-8") as string;
  } catch {
    return undefined;
  }
}

function findJsonObject(raw: string | undefined): JsonRecord | undefined {
  const parsed = parseJson(raw);
  if (isRecord(parsed)) return parsed;

  // Agents sometimes include the command output in a fenced block or around
  // a short explanation. Keep the task contract forgiving without accepting
  // an arbitrary value as a successful hunk result.
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  if (start === 0 && end === raw.length - 1) return undefined;
  return findJsonObject(raw.slice(start, end + 1));
}

function parseHunkCheck(raw: string | undefined): HunkCheckOutput | undefined {
  const parsed = findJsonObject(raw);
  if (!parsed || typeof parsed.passes !== "boolean" || !Array.isArray(parsed.blocking_threads)) {
    return undefined;
  }

  const blockingThreads: HunkBlockingThread[] = [];
  for (const value of parsed.blocking_threads) {
    if (!isRecord(value) || typeof value.body !== "string") return undefined;
    const replies = Array.isArray(value.replies)
      ? value.replies.filter((reply): reply is string => typeof reply === "string")
      : [];
    blockingThreads.push({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.file === "string" ? { file: value.file } : {}),
      ...(typeof value.line === "number" || isRecord(value.line)
        ? { line: value.line as HunkBlockingThread["line"] }
        : {}),
      ...(typeof value.taxonomy === "string" ? { taxonomy: value.taxonomy } : {}),
      body: value.body,
      replies,
    });
  }

  return { passes: parsed.passes, blocking_threads: blockingThreads };
}

/// mt hunk サブコマンドを実行して stdout を返す。
/// exit 1 はゲートブロックなど正常系の出力を伴うため、throw せず stdout を回収する。
// oxlint-disable-next-line no-unused-vars
function runHunkCommand(args: string[]): string {
  try {
    return String(
      execFileSync("mt", ["hunk", ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        // bun は process.env への代入を実行パス解決に反映しないため、
        // テストの PATH 差し替えが効くよう明示的に現在の env を渡す
        env: { ...process.env },
      }),
    );
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : String(stdout ?? "");
  }
}

/// TUI 生存判定は `hunk session get --repo <root> --json` の成功のみを正とする。
/// `mt hunk status` は `.hunk/hunk-review.json`（`mt hunk start` 後に作成）が
/// 無いと TUI が生きていても "none" を返すため、start 前のゲートでは使えない。
function isHunkSessionLive(): boolean {
  try {
    const repoRoot = String(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }),
    ).trim();
    try {
      execFileSync("mt", ["hunk", "session", "get", "--repo", repoRoot, "--json"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      return true;
    } catch {
      execFileSync("hunk", ["session", "get", "--repo", repoRoot, "--json"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      return true;
    }
  } catch {
    return false;
  }
}

function formatHunkFeedback(ctx: PromptCtx): string | undefined {
  const raw =
    findArtifactText(ctx.artifacts, HUNK_CHECK_KEY) ??
    readSessionFile(ctx.sessionDir, HUNK_CHECK_KEY);
  const result = parseHunkCheck(raw);
  if (!result || result.passes || result.blocking_threads.length === 0) return undefined;

  const lines = [
    "## hunk の人間フィードバック（前回 check_hunk の blocking_threads）",
    "",
    "以下は hunk 上の未解決コメントと、そのコメントに対する人間のコメントです。担当スコープに該当するものを修正し、コメントの taxonomy（`[question]` / `[issue]`）を保って扱ってください。",
    "",
  ];

  for (const [index, thread] of result.blocking_threads.entries()) {
    const location = thread.file
      ? `${thread.file}${thread.line === undefined || thread.line === null ? "" : `:${typeof thread.line === "number" ? thread.line : `${thread.line.start}-${thread.line.end}`}`}`
      : "(file-level)";
    lines.push(`### ${index + 1}. ${location} (${thread.taxonomy ?? "unknown"})`);
    if (thread.taxonomy === "human") {
      // hunk の人間コメント（source: user）は body がコメント本文そのもの。
      // replies は hunk がフラット構造のため常に空。
      lines.push(`人間コメント（原文）: ${thread.body}`);
    } else {
      lines.push(`指摘: ${thread.body}`);
      if (thread.replies && thread.replies.length > 0) {
        for (const reply of thread.replies) {
          lines.push(`人間 reply: ${reply}`);
        }
      } else {
        lines.push("人間 reply: (なし。未解決の指摘として確認する)");
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * tado の task goto は失敗元だけを再キューするため、最後の
 * check_hunk から execute_work に戻る際は、間にある review steps も
 * pending に戻しておく。これがないと、修正後に check_hunk だけが再実行
 * され、execute_work → review_work → hunk のサイクルにならない。
 *
 * tado のセッション DB は共有の ~/.tado/workflow.db（TADO_HOME で上書き可）に
 * あり、セッションディレクトリには置かれない（countReviewRounds と同じ）。
 */
function resetReviewCycle(sessionDir: string): void {
  const dbPath = getWorkflowDbPath();
  if (!fs.existsSync(dbPath)) return;

  // PromptCtx/CheckCtx.sessionId は tado が値を設定しないため sessionDir の
  // basename（= セッション ID）から導出する（countReviewRounds と同じ）
  const sessionId = basename(sessionDir);
  const db = new Database(dbPath);
  try {
    const executeStep = db
      .query("SELECT step_index FROM steps WHERE session_id = ? AND step_key = 'execute_work'")
      .get(sessionId);
    if (!executeStep || typeof executeStep.step_index !== "number") return;
    db.run(
      "UPDATE steps SET status = 'pending', retry_count = 0 WHERE session_id = ? AND step_index > ?",
      sessionId,
      executeStep.step_index,
    );
  } finally {
    db.close();
  }
}

function getWorkflowDbPath(): string {
  const configuredHome = process.env.TADO_HOME?.trim();
  const home = configuredHome || os.homedir();
  return join(home, ".tado", "workflow.db");
}

function findArtifactText(artifacts: ArtifactRecord[], key: string): string | undefined {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) return undefined;
  try {
    return fs.readFileSync(match.filePath, "utf-8") as string;
  } catch {
    return undefined;
  }
}

// plan-run 用: Issue body から effort を解析するヘルパ (mt-review-diff の parseEffortArgs を再利用しつつ Issue body マーカーも受理)
function parseEffortFromIssueBody(body: string | undefined): {
  width?: string;
  depth?: string;
  base?: string;
  target?: string;
} {
  if (!body) return {};
  // まず mt-review-diff と同じプロンプト記法を Issue body 内でも受理 (例: <!-- effort: width=high depth=low --> や width=high)
  const parsed = parseEffortArgs(body);
  // 追加で Issue body の検証設定セクションの明示記法も受理: "width: high" や "depth: low"
  const widthMatch = body.match(/width\s*[:=]\s*(low|medium|high|xhigh|max)/i);
  if (widthMatch && !parsed.width) parsed.width = widthMatch[1].toLowerCase() as any;
  const depthMatch = body.match(/depth\s*[:=]\s*(max|xhigh|high|medium|low)/i);
  if (depthMatch && !parsed.depth) parsed.depth = depthMatch[1].toLowerCase() as any;
  return parsed;
}

function ensureEffortFromIssueBody(
  sessionDir: string,
  artifacts: ArtifactRecord[],
): { width: string; depth: string } | undefined {
  const issueBody = (() => {
    try {
      const t = findArtifactText(artifacts, "issue-body.md");
      if (t) return t;
    } catch {}
    return (
      readSessionFile(sessionDir, "issue-body.md") ??
      readSessionFile(sessionDir, "issue-body.md".replace(".md", ".txt"))
    );
  })();
  const effort = parseEffortFromIssueBody(issueBody);
  if (effort.width && effort.depth) {
    // check は純粋判定が契約のためファイル生成は行わない (生成は collect_context の task 側で実施)
    return { width: effort.width, depth: effort.depth };
  }
  return undefined;
}

const def: WorkflowDef = {
  id: "mt-plan-run",
  description:
    "GitHub Issueベースの計画を選択し実行して履歴を更新するワークフロー。実行・検証・修正サイクルを管理し計画を完遂させる。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
  },

  steps: [
    // -------------------------------------------------------------------
    // Step 1: 計画の特定
    // -------------------------------------------------------------------
    {
      key: "identify_plan",
      phase: "計画の特定",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: "approve", label: "計画を特定した", desc: "Issue番号を確認し次へ進む" },
          { value: "abort", label: "中断" },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 2: 実行開始（refined → in-progress）
    // -------------------------------------------------------------------
    {
      key: "start_execution",
      phase: "実行開始",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。",
            "",
            "## 手順",
            "",
            "1. ユーザーが指定した計画 Issue 番号 `<number>` を確認する（初回ヒアリングで取得済み）",
            "",
            "2. Issue の存在・状態を検証する:",
            "",
            "```bash",
            "gh issue view <number> --json state,labels,number,title,url",
            "```",
            "",
            "- `kind/plan` label が付与されていることを確認",
            "- `state` が `OPEN` であることを確認",
            "",
            "3. `list-plans.ts` で status を確認し、`refined` または `in-progress` であることを検証する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "mt-plan-list-plans.ts")}`,
            "```",
            "",
            "- `draft` なら `mt-plan-create` へ案内して中断",
            "- `done` なら「完了済み。再開しますか？」と確認",
            "",
            "4. GitHub Sub Issue を確認する。Sub Issue を持つ親計画は実行できないため、子計画を選び直して中断する:",
            "",
            "```bash",
            "gh api repos/<owner>/<repo>/issues/<number>/sub_issues",
            "```",
            "",
            "5. `transition-plan.ts` を使って `refined` → `in-progress` に遷移する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "../_shared/mt-plan-transition-plan.ts")} <number> in-progress`,
            "```",
            "",
            "既に `in-progress` の場合はスキップする。",
            "",
            "6. Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:",
            "",
            "```bash",
            "gh issue view <number> --json body",
            "```",
            "",
            `読み込んだ body を ${ctx.sessionDir}/issue-body.md にも保存する。`,
            "",
            "7. 読み込んだ内容の要点を報告する:",
            "   - 完了条件の数と概要",
            "   - 主要な方針",
            "   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）",
            "",
            "8. 計画番号と Issue body を保存する: report 時の `artifacts` に以下を含めること:",
            "```json",
            `[{"key": "plan_number", "path": "<number>"}, {"key": "issue-body.md", "path": "${ctx.sessionDir}/issue-body.md"}]`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 2.5: ドキュメント転記
    // -------------------------------------------------------------------
    {
      key: "transcribe_docs",
      phase: "ドキュメント転記",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      condition: (ctx: ConditionCtx): boolean => {
        const body = findArtifactText(ctx.artifacts, "issue-body.md");
        return body?.includes("## 📄 ドキュメント") ?? false;
      },
      task: {
        action: "orchestrate",
        buildPrompt: (_ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "計画 Issue の `## 📄 ドキュメント` セクションをリポジトリの実ファイルへ転記する。",
            "",
            "## 手順",
            "",
            "### 1. ドキュメントセクションの抽出",
            "",
            `セッションディレクトリの issue-body.md から \`## 📄 ドキュメント\` セクションを抽出する。`,
            "",
            "### 2. 各ブロックの書き出し",
            "",
            "各 `### <リポジトリ相対パス>` 見出しと直下のコードフェンス（ファイル全文）を、指定パスへ書き出す。",
            "",
            "- ADR 連番が既存ファイルと衝突する場合は、次の空き番号へリネームして書き出す",
            "- 既存ファイル（主に `CONTEXT.md`）がある場合は既存内容を読み、計画側の内容を正としてマージする（`_Avoid_` ルールに従う）",
            "- 書き出しは未コミット差分として残す（コミットは行わない）",
            "",
            "### 3. 書き出し結果の報告",
            "",
            "書き出したファイル一覧（パス・新規/更新・マージの有無）を報告する。",
            "",
            // セッション情報はエンジンが自動付与する（ADR-0003）
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 3: 作業実行（executor SubAgent 委譲・並列）
    // -------------------------------------------------------------------
    {
      key: "execute_work",
      phase: "作業実行",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const hunkFeedback = formatHunkFeedback(ctx);
          return [
            "## 目的",
            "",
            "計画 Issue の `## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針` に従って作業を実行する。",
            "作業の実施は必ず `mt-plan-work-executor` SubAgent に委譲する。オーケストレーター自身はリポジトリのファイル編集を行わず、ミッションの割り振り・進行管理・Issue body 更新に専念する。",
            "",
            "## 修正ソース（再実行時に適用）",
            "",
            "execute_work に戻ってきた場合、以下のソースから修正指示を統合して executor SubAgent に渡す:",
            "",
            "1. **findings.json（旧 agent-review.json）の must 指摘（または findings.json の must）**（review_work の SubAgent レビューで検出された必須修正）",
            "2. **findings.json の should 指摘**（start_hunk_review で `[question]` として提示されたもの）",
            "3. **findings.json の want 指摘のうち人間コメントが付いたもの**（hunk コメント一覧で同一 newLine に user コメントが存在する want のみ）",
            "4. **hunk の blocking_threads**（`hunk-check.json` / `verdict.json` の blocking_threads。人間が hunk TUI で追加した user コメントを含む）",
            "",
            "各ソースの存在確認:",
            "- セッションディレクトリの `findings.json`（存在しなければ旧 `agent-review.json`）を読み、must / should / want の全指摘を抽出する",
            "- セッションディレクトリの `verdict.json` と `hunk-check.json` を読み、`blocking_threads[].body` を抽出する（`verdict.json` が SoT）",
            "- 存在しないファイルは無視する（初回実行時は修正ソースなし）",
            "",
            "want 指摘の修正対象判定:",
            '- リポジトリルートで `hunk session comment list --repo "$(git rev-parse --show-toplevel)" --type all --json` を実行し、コメント一覧を取得する（source: "agent" = AI 適用、source: "user" = 人間）',
            '- want 指摘（`[question] (want)`）のうち、同一ファイルの同一行（newRange / oldRange の開始行が一致）に `source: "user"` の人間コメントが存在するものだけを修正対象にする',
            "- 無視された want（rm されず人間コメントなし）は修正対象にしない",
            "",
            "修正指示の仕分け:",
            "- 指摘を該当ミッションのスコープで仕分けし、担当の executor SubAgent に修正指示として渡す",
            "- must / should はすべて対応対象。want は人間コメントが付いたもののみ対応対象",
            "- hunk の人間コメントはテキスト原文として executor に渡し、要約・省略・taxonomy の変更をしない",
            "",
            "対応完了時のコメント削除（rm）:",
            '- executor は対応したコメントを `hunk session comment rm --repo "$(git rev-parse --show-toplevel)" <noteId>` で削除する',
            '- must / should: 対応した AI コメント（source: "agent"）を rm する',
            '- 人間コメントが付いた want: 対応後に AI コメントと人間コメント（source: "user"）の両方を rm する',
            "- 人間コメントが付いていない want: 修正対象外のため rm しない",
            "",
            ...(hunkFeedback ? [hunkFeedback, ""] : []),
            "## 手順",
            "",
            "### 1. ミッションの読み取り",
            "",
            "Issue body（`gh issue view <number> --json body`）から `## 🧩 ミッション` セクションを読み取る:",
            "",
            "- セクションがある場合: `### 実行順` の Wave 定義と各 `### M<n>: <名前>` ミッションのスコープ・完了条件を把握する",
            "- セクションがない場合: 計画全体を 1 ミッション（`M1: 全体`、スコープは計画のアウトプット範囲、完了条件は全番号）として扱う",
            "",
            "### 2. executor SubAgent の起動",
            "",
            'Wave 方式に従って、Task ツールで `subagent_type = "mt-plan-work-executor"` を起動する:',
            "",
            "- 同じ Wave 内のミッションは並列起動する（最大 5 同時）。同一メッセージで複数の Task ツール呼び出しを行う",
            "- 異なる Wave は番号順に直列実行する（Wave 2 は Wave 1 の全ミッション完了後に開始）",
            "- 各 SubAgent に渡す情報:",
            "  - 計画 Issue body 全文（完了条件・方針・アウトプットの判断に必要）",
            "  - 担当ミッション定義（ID・名前・スコープ・完了条件番号・Wave 所属）",
            "  - 修正指示（再実行時のみ: findings.json（旧 agent-review.json含む）、verdict.json/hunk-check.json の blocking_threads / user コメントの該当指摘）",
            "",
            "### executor の完了報告契約",
            "",
            "各 executor は、作業結果を次の構造化 JSON オブジェクトとして必ず返す:",
            "```json",
            "{",
            '  "changedFiles": ["<repository-relative-path>"],',
            '  "checks": [{"command": "<command>", "result": "<result>"}],',
            '  "unresolvedIssues": []',
            "}",
            "```",
            "",
            "### 3. 完了報告の集約",
            "",
            "- 全ミッションの完了報告（変更ファイル一覧・検証結果・未解決事項）を集約する",
            "- ミッションがスコープ外変更の必要を報告した場合は、作業を止めてユーザーに計画修正を提案する",
            '- いずれかのミッションが失敗した場合は report を `status: "failed"` とし、失敗内容を errors に含める',
            "",
            "## Issue body 更新（オーケストレーターが実施）",
            "",
            "以下のタイミングで更新する:",
            "- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行済み）",
            "- 全ミッション完了後: `## 🐢 履歴` へミッションごとの変更内容と確認結果を追記",
            "- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記",
            "- 中断時: `## 🐢 履歴` または `## 🐿️ メモ` へ完了済みミッション・次回再開位置・残論点を残す",
            "",
            "更新前は必ず `gh issue view` で body を読み、他者の差分を上書きしない。",
            "",
            "`## 🐿️ メモ` の運用:",
            "- `💭 背景:` … 前提・制約",
            "- `🤔 論点:` … 未決事項・要確認事項",
            "- `🧭 指針:` … 合意済み判断・運用ルール",
            "- 未解決の論点は Done 前に解消・方針へ取り込み・スコープ外化のいずれかを行う",
            "",
            "```bash",
            "gh issue edit <number> --repo <repo> --body-file <tmpfile>",
            "```",
            "",
            // セッション情報はエンジンが自動付与する（ADR-0003）
            "",
            "## 禁止事項",
            "",
            "- オーケストレーター自身がリポジトリのファイルを編集しない（作業は必ず executor SubAgent へ委譲）",
            "- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する",
            "- ユーザー承認前に `done` 化しない",
            "- 全ミッションの完了前に次のステップへ進まない",
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (ctx.attemptResult.status !== "completed") {
          return { status: "error", reasons: [ctx.attemptResult.errors ?? "execute_work failed"] };
        }
        return { status: "pass", reasons: ["execution completed"] };
      },
    },

    // -------------------------------------------------------------------
    // Step 3.5: hunk セッション確保（レビューサイクルの前提条件）
    // -------------------------------------------------------------------
    {
      key: "ensure_hunk_session",
      phase: "hunk セッション確保",
      type: "human_gate",
      maxRetries: 3,
      onFail: { action: "escalate" },
      humanGate: {
        presentArtifacts: [],
        choices: [
          {
            value: "approve",
            label: "hunk TUI を起動した（ready）",
            desc: `ターミナルで \`BASE_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"\` と \`hunk diff "$BASE_BRANCH"\` を実行してセッションを active にする。report 後、check が \`hunk session get\` で再検証し失敗ならリトライされる`,
          },
          { value: "abort", label: "中断" },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => {
        // start 前は `.hunk/hunk-review.json` が存在しないため `mt hunk status`
        // は常に "none" を返す。TUI 生存の検出には `hunk session get` を使う
        if (isHunkSessionLive()) {
          return { status: "pass", reasons: ["hunk session is live (`hunk session get`)"] };
        }
        return {
          status: "fail",
          reasons: [
            "hunk session is not live. ターミナルで `hunk diff <base-branch>` を起動してから ready を選択してください",
          ],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 4: 検証強度解決（mt-review-diff から import — plan-run では Issue body 由来の effort を優先）
    //         起動インターフェースはプロンプト記法(width=… depth=… base=… target=…)と最初のhuman_gateハイブリッドを共通化
    // -------------------------------------------------------------------
    {
      ...resolveEffortStep,
      phase: "検証強度解決",
      check: (ctx: CheckCtx): CheckResult => {
        // まず SoT の check を試す (effort.json が既にあればそのまま pass) — 純粋検証のみ
        const origCheck = resolveEffortStep.check as (ctx: CheckCtx) => CheckResult;
        const orig = origCheck(ctx);
        if (orig.status === "pass") return orig;
        // effort.json がない場合、Issue body から width/depth を抽出して判定する (純粋読取のみ、生成は collect_context 側)
        const derived = ensureEffortFromIssueBody(ctx.sessionDir, ctx.artifacts);
        if (derived) {
          // round 上限3のバイパス防止: 既存 effort.json が存在し round>3 なら fail を維持
          // REVIEW_EFFORT_KEY は "effort.json" と同値のため単一キーに統一 (ai-3 重複解消)
          const existingRaw =
            findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY) ??
            readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
          if (existingRaw) {
            try {
              const parsed = JSON.parse(existingRaw) as Record<string, unknown>;
              const round = typeof parsed.round === "number" ? parsed.round : 1;
              if (round > 3) {
                return { status: "fail", reasons: [`round limit exceeded: round=${round} > 3`] };
              }
            } catch {}
          }
          return {
            status: "pass",
            reasons: [
              `effort derived from issue body: width=${derived.width} depth=${derived.depth}`,
            ],
          };
        }
        return orig;
      },
    },

    // -------------------------------------------------------------------
    // Step 4.5: 差分収集（mt-review-diff から import — plan-run では branch diff + unstaged を収集）
    //           追加で Issue body 由来の effort.json 生成を担う（check は純粋判定のため）
    // -------------------------------------------------------------------
    {
      ...collectContextStep,
      phase: "差分収集",
      task: {
        ...collectContextStep.task,
        buildPrompt: (ctx: PromptCtx) => {
          const basePrompt = (
            collectContextStep.task as unknown as { buildPrompt: (ctx: PromptCtx) => string }
          ).buildPrompt(ctx);
          const extra = [
            "",
            "## 追加手順（plan-run 固有: Issue body 由来の effort 補完）",
            "",
            "collect_context の agent は、effort.json が存在しない場合に以下を優先順位で補完する:",
            "1. セッションディレクトリの issue-body.md（または artifacts の issue-body.md）から `width: <value>` / `depth: <value>` または `<!-- effort: width=... depth=... -->` を解析し、width/depth を抽出できた場合はその値で effort.json を生成する",
            "2. 上記で抽出できない場合は、プロンプト記法 width=… depth=… を解析し既定値 medium/medium で補完する（mt-review-diff の既定動作）",
            "3. 生成時は `{ width, depth, round: 1 }` を effort.json として保存し、artifacts へ登録する",
            "なお check 段階ではファイル生成を行わず、ここで初めて生成する（check は純粋検証のみ）。",
          ].join("\n");
          return basePrompt + extra;
        },
      },
    },

    // -------------------------------------------------------------------
    // Step 5: 検証者起動（mt-review-diff から import — 旧 review_work 置換）
    // -------------------------------------------------------------------
    {
      ...runReviewersStep,
      phase: "検証者起動",
    },

    // -------------------------------------------------------------------
    // Step 5: findings 公開（mt-review-diff から import — 旧 start_hunk_review 置換）
    // -------------------------------------------------------------------
    {
      ...publishFindingsStep,
      phase: "findings 公開",
    },

    // -------------------------------------------------------------------
    // Step 6: 人間レビュー待機（mt-review-diff から import — 旧 await_review 置換）
    //         2段階ループ: 自律ループ中（must>0）は人へ渡さず自動で pass し、must 0 のときのみ人レビューを行う
    // -------------------------------------------------------------------
    {
      ...awaitHumanReviewStep,
      phase: "人間レビュー待機",
      check: (ctx: CheckCtx): CheckResult => {
        // 自律ループ中は must が残っていれば人レビューをスキップし自動 pass
        const findingsRaw =
          findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY) ??
          readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY) ??
          readSessionFile(ctx.sessionDir, "findings.json");
        const findingsResult = validateFindingsJson(findingsRaw);
        if (findingsResult.valid && findingsResult.parsed!.counts.must > 0) {
          return {
            status: "pass",
            reasons: [
              `autonomous must loop: must=${findingsResult.parsed!.counts.must} -> skip human gate`,
            ],
          };
        }
        const origCheck = awaitHumanReviewStep.check as (ctx: CheckCtx) => CheckResult;
        return origCheck(ctx);
      },
    },

    // -------------------------------------------------------------------
    // Step 7: verdict 収集 & ゲート判定（mt-review-diff から import — 旧 check_hunk 置換）
    //         plan-run が loop 所有者として resetReviewCycle を保持。新ワークフロー側は verdict までで終端する設計を維持
    // -------------------------------------------------------------------
    {
      ...collectVerdictStep,
      key: "collect_verdict",
      phase: "verdict 収集",
      maxRetries: 0,
      onFail: { action: "goto", target: "execute_work", requeueSource: true },
      check: (ctx: CheckCtx): CheckResult => {
        // mt-review-diff の検証 (schema, round 上限) をまず実行
        const origCheck = collectVerdictStep.check as (ctx: CheckCtx) => CheckResult;
        const origResult = origCheck(ctx);

        // schema 的に error の場合は即 error を返す (loop しない)
        if (origResult.status === "error") return origResult;

        // round limit exceeded は human_gate で継続/中止を選択すべきで、自動 loop しない
        const isRoundLimit = origResult.reasons.some((r: string) => r.includes("round limit"));
        if (isRoundLimit) return origResult;

        // daemon 偽装検出は最優先で fail を維持（wrapper が passed を誤って pass にしない）
        const isDaemonMismatch = origResult.reasons.some((r: string) =>
          r.includes("does not match"),
        );
        if (isDaemonMismatch) return origResult;

        // verdict.json の passed を判定し、未通過なら execute_work へループする
        const verdictRaw =
          findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY) ??
          readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY) ??
          (ctx.attemptResult.subagentOutput as string | undefined);
        const verdictResult = validateVerdictJson(verdictRaw);
        // validateVerdict が有効でない場合は findings から合成を試みる (2段階ループ対応)
        if (!verdictResult.valid) {
          const findingsRaw =
            findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY) ??
            readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
          const findingsResult = validateFindingsJson(findingsRaw);
          if (!findingsResult.valid) return origResult;
          const { must, should } = findingsResult.parsed!.counts;
          const round = findingsResult.parsed!.round;
          // 自律ループ: must が残っていれば即 fail（hunk不要）
          if (must > 0) {
            if (round > 3) {
              return {
                status: "fail",
                reasons: [
                  `round limit exceeded: round=${round} > 3 (autonomous). 継続/中止を human_gate で選択してください`,
                ],
              };
            }
            try {
              resetReviewCycle(ctx.sessionDir);
            } catch (error) {
              return {
                status: "error",
                reasons: [`failed to reset review cycle: ${String(error)}`],
              };
            }
            return {
              status: "fail",
              reasons: [`verdict blocked (autonomous): must=${must} should=${should}`],
            };
          }
          // 人レビュー段階: must 0 後の should/humanWant を gate
          // should が残っていれば fail（hunkで人が確認した前提）
          if (should > 0) {
            try {
              resetReviewCycle(ctx.sessionDir);
              // 人レビュー後の再自律のため autonomous round をリセット（effort.json の round を 1 に）
              try {
                const effortPath = join(ctx.sessionDir, "effort.json");
                const effortRaw = fs.readFileSync(effortPath, "utf-8");
                const effort = JSON.parse(effortRaw) as Record<string, unknown>;
                effort.round = 1;
                fs.writeFileSync(effortPath, JSON.stringify(effort, null, 2));
              } catch {}
            } catch (error) {
              return {
                status: "error",
                reasons: [`failed to reset review cycle: ${String(error)}`],
              };
            }
            return {
              status: "fail",
              reasons: [`verdict blocked (human): should=${should} must=${must}`],
            };
          }
          // must 0 かつ should 0 なら want は人コメント付きのみが対象だが、現段階では hunk コメントがないため pass とする
          // 実際の want昇格は hunk session comment list で判定するが、verdict 合成時は should 0 で pass
          return {
            status: "pass",
            reasons: [`verdict passed (synthesized): round=${round} must=${must} should=${should}`],
          };
        }

        const verdict = verdictResult.parsed!;
        // 自律段階の round 上限は verdict.round で判定（通算）。上限到達は人へエスカレーション
        if (verdict.round > 3) {
          return {
            status: "fail",
            reasons: [
              `round limit exceeded: round=${verdict.round} > 3. 継続/中止を human_gate で選択してください`,
            ],
          };
        }
        if (verdict.passed) {
          return {
            status: "pass",
            reasons: [
              `verdict passed: round=${verdict.round} blocking=${verdict.blocking_threads.length}`,
            ],
          };
        }

        // blocked -> loop へ。workflow.db のループ制御は plan-run が所有
        // 2段階ループ: must残なら自律、should/humanWant残なら人レビュー後の再自律（autonomous round リセット）
        const findingsRawForReset =
          findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY) ??
          readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
        const findingsForReset = validateFindingsJson(findingsRawForReset);
        const isHumanStage = findingsForReset.valid && findingsForReset.parsed!.counts.must === 0;
        try {
          resetReviewCycle(ctx.sessionDir);
          if (isHumanStage) {
            try {
              const effortPath = join(ctx.sessionDir, "effort.json");
              const effortRaw = fs.readFileSync(effortPath, "utf-8");
              const effort = JSON.parse(effortRaw) as Record<string, unknown>;
              effort.round = 1;
              fs.writeFileSync(effortPath, JSON.stringify(effort, null, 2));
            } catch {}
          }
        } catch (error) {
          return { status: "error", reasons: [`failed to reset review cycle: ${String(error)}`] };
        }
        const blocking = verdict.blocking_threads.map(
          (t: { taxonomy?: string; file?: string; body: string }) =>
            `${t.taxonomy ?? "blocking"} ${t.file ?? "(file-level)"}: ${t.body}`,
        );
        return {
          status: "fail",
          reasons: blocking.length > 0 ? blocking : ["verdict is blocked — goto execute_work"],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 8: 完了処理（in-progress → done）
    // -------------------------------------------------------------------
    // Step 8: 完了処理（in-progress → done）
    // -------------------------------------------------------------------
    {
      key: "finalize_done",
      phase: "完了処理",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "計画 Issue を `done` に遷移し、完了処理を行う。",
            "",
            "## 手順",
            "",
            "1. Issue body を再読み込みし、完了条件がすべて満たされていることを最終確認する",
            "",
            "2. `transition-plan.ts` を使って `in-progress` → `done` に遷移する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "../_shared/mt-plan-transition-plan.ts")} <number> done`,
            "```",
            "",
            "このコマンドは以下を自動実行する:",
            "- GitHub Project の Status を `done` に更新",
            "- Issue を close",
            "- `## 🐢 履歴` へ遷移エントリを追記",
            "- 親計画が存在する場合は自動的に親の状態集約を行う（出力の `parent:` 行を確認）",
            "",
            "3. 完了を報告する:",
            "   - Issue の URL・番号",
            "   - 完了した作業",
            "   - 残っている未決事項（あれば）",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },
  ],
};

export default def;
