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
import { loadConfig } from "../_shared/mt-plan-init-config";

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

const REVIEW_AXES = ["essentiality", "acceptance", "scope", "alignment", "quality"];
const HUNK_START_KEY = "hunk-start.json";
const HUNK_COMMENTS_KEY = "hunk-comments.json";
const HUNK_CHECK_KEY = "hunk-check.json";

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
  const fs = require("node:fs");
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

function optionalLocation(item: JsonRecord): { filePath?: string; position?: unknown } {
  const location = isRecord(item.location) ? item.location : undefined;
  const filePathCandidate =
    item.filePath ?? item.file_path ?? location?.filePath ?? location?.file_path;
  const positionCandidate = item.position ?? location?.position;
  return {
    ...(typeof filePathCandidate === "string" && filePathCandidate.trim()
      ? { filePath: filePathCandidate }
      : {}),
    ...(isRecord(positionCandidate) ? { position: positionCandidate } : {}),
  };
}

/// agent-review.json の position（{side, line}）を hunk の apply 形式
/// （newLine / oldLine）へ変換する。行指定のない指摘は newLine を省略し、
/// mt hunk start 側の newLine: 1 合成に任せる。
function positionToHunkLines(
  position: unknown,
): { newLine?: number; oldLine?: number } | undefined {
  if (!isRecord(position)) return undefined;
  const line = position.line;
  if (typeof line !== "number") return undefined;
  if (position.side === "old") return { oldLine: line };
  return { newLine: line };
}

const SEVERITY_EMOJI: Record<string, string> = {
  must: "🚨",
  should: "⚠️",
  want: "💡",
};

const TAXONOMY_EMOJI: Record<string, string> = {
  issue: "🐛",
  question: "🙋",
};

const AXIS_EMOJI: Record<string, string> = {
  essentiality: "🎯",
  acceptance: "✅",
  scope: "📦",
  alignment: "🧭",
  quality: "✨",
};

const SEVERITY_BORDER_COLOR: Record<string, string> = {
  must: "danger",
  should: "warning",
  want: "muted",
};

function escapeStml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatComment(input: {
  severity: "must" | "should" | "want";
  axis: string;
  detail: string;
  filePath?: string;
  line?: number;
  suggestions?: string[];
}): { markup: string; summary: string } {
  const severityEmoji = SEVERITY_EMOJI[input.severity] ?? "";
  const taxonomy = input.severity === "must" ? "issue" : "question";
  const taxonomyEmoji = TAXONOMY_EMOJI[taxonomy] ?? "";
  const axisEmoji = AXIS_EMOJI[input.axis] ?? "";
  const borderColor = SEVERITY_BORDER_COLOR[input.severity] ?? "muted";
  const title = `${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis}`;
  const target = input.filePath
    ? input.line !== undefined
      ? `${input.filePath}:${input.line}`
      : input.filePath
    : "general";
  const detailHead = input.detail.trim().split("\n")[0]?.trim() ?? "";
  const truncatedHead = detailHead.length > 80 ? `${detailHead.slice(0, 77)}...` : detailHead;
  const summary = `${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis} | ${target} — ${truncatedHead}`;
  const escapedDetail = escapeStml(input.detail.trim()).replace(/\n/g, "<br/>");
  const targetBlock = `<text><dim>📁 ${escapeStml(target)}</dim></text>`;
  const detailBlock = `<text>${escapedDetail}</text>`;
  let markup = `<box border border-color="${borderColor}" padding-x="1" padding-y="1" title="${title}">\n`;
  markup += `${targetBlock}\n`;
  markup += `<spacer size="1" />\n`;
  markup += `${detailBlock}`;
  if (input.suggestions && input.suggestions.length > 0) {
    const items = input.suggestions
      .map((s) => `<item>${escapeStml(s).replace(/\n/g, "<br/>")}</item>`)
      .join("");
    markup += `\n<spacer size="1" />\n<list>${items}</list>`;
  }
  markup += `\n</box>`;
  return { markup, summary };
}

export function buildHunkComments(reviewRaw: string | undefined): JsonRecord[] {
  const comments: JsonRecord[] = [];
  const review = findJsonObject(reviewRaw);
  const axes = isRecord(review?.axes) ? review.axes : undefined;

  if (axes) {
    for (const axis of REVIEW_AXES) {
      const items = axes[axis];
      if (!Array.isArray(items)) continue;
      for (const value of items) {
        if (!isRecord(value)) continue;
        const severity = value.severity;
        const detail = value.detail;
        if (severity !== "must" && severity !== "should" && severity !== "want") continue;
        if (typeof detail !== "string" || !detail.trim()) continue;

        const location = optionalLocation(value);
        const filePath = typeof location.filePath === "string" ? location.filePath : undefined;
        const positionLines = positionToHunkLines(location.position);
        const line = positionLines?.newLine ?? positionLines?.oldLine;

        const rawSuggestions =
          (value as Record<string, unknown>).suggestions ??
          (value as Record<string, unknown>).suggestion ??
          (value as Record<string, unknown>).proposals ??
          (value as Record<string, unknown>).proposal;
        let suggestions: string[] | undefined;
        if (Array.isArray(rawSuggestions)) {
          const filtered = (rawSuggestions as unknown[]).filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          );
          if (filtered.length > 0) suggestions = filtered.map((s) => s.trim());
        } else if (typeof rawSuggestions === "string" && rawSuggestions.trim()) {
          suggestions = [rawSuggestions.trim()];
        }

        const { markup, summary } = formatComment({
          severity: severity as "must" | "should" | "want",
          axis,
          detail: detail.trim(),
          filePath,
          line,
          suggestions,
        });
        const comment: JsonRecord = { summary, markup };
        if (filePath) comment.filePath = filePath;
        if (positionLines) Object.assign(comment, positionLines);
        comments.push(comment);
      }
    }
  }

  return comments;
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
function runHunkCommand(args: string[]): string {
  const { execFileSync } = require("node:child_process") as {
    execFileSync: (
      command: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => string | Buffer;
  };
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

/// セッション活性判定は `mt hunk status` の文言一致のみを正とする（ADR-0016）。
function isHunkSessionActive(): boolean {
  return runHunkCommand(["status"]).includes("hunk review session: active");
}

/// TUI 生存判定は `hunk session get --repo <root> --json` の成功のみを正とする。
/// `mt hunk status` は `.hunk/hunk-review.json`（`mt hunk start` 後に作成）が
/// 無いと TUI が生きていても "none" を返すため、start 前のゲートでは使えない。
function isHunkSessionLive(): boolean {
  const { execFileSync } = require("node:child_process") as {
    execFileSync: (
      command: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => string | Buffer;
  };
  try {
    const repoRoot = String(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }),
    ).trim();
    execFileSync("hunk", ["session", "get", "--repo", repoRoot, "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    return true;
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
  const fs = require("node:fs");
  const dbPath = getWorkflowDbPath();
  if (!fs.existsSync(dbPath)) return;

  // PromptCtx/CheckCtx.sessionId は tado が値を設定しないため sessionDir の
  // basename（= セッション ID）から導出する（countReviewRounds と同じ）
  const sessionId = basename(sessionDir);
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => {
      query: (sql: string) => { get: (params?: unknown[]) => JsonRecord | undefined };
      run: (sql: string, params?: unknown[]) => void;
      close: () => void;
    };
  };
  const db = new Database(dbPath);
  try {
    const executeStep = db
      .query("SELECT step_index FROM steps WHERE session_id = ? AND step_key = 'execute_work'")
      .get(sessionId);
    if (!executeStep || typeof executeStep.step_index !== "number") return;
    db.run(
      "UPDATE steps SET status = 'pending', retry_count = 0 WHERE session_id = ? AND step_index > ?",
      [sessionId, executeStep.step_index],
    );
  } finally {
    db.close();
  }
}

function validateReviewJson(raw: string | undefined): {
  valid: boolean;
  mustCount: number;
  error?: string;
} {
  if (!raw) return { valid: false, mustCount: -1, error: "agent-review.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, mustCount: -1, error: "agent-review.json is not valid JSON" };
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.round !== "number")
    return { valid: false, mustCount: -1, error: "missing or invalid round" };
  if (typeof r.axes !== "object" || r.axes === null)
    return { valid: false, mustCount: -1, error: "missing axes" };
  const expectedAxes = ["essentiality", "acceptance", "scope", "alignment", "quality"];
  for (const k of expectedAxes) {
    if (!(k in r.axes)) return { valid: false, mustCount: -1, error: `missing axis: ${k}` };
    if (!Array.isArray((r.axes as Record<string, unknown>)[k]))
      return { valid: false, mustCount: -1, error: `axis ${k} is not an array` };
  }
  if (typeof r.counts !== "object" || r.counts === null)
    return { valid: false, mustCount: -1, error: "missing counts" };
  const c = r.counts as Record<string, unknown>;
  if (typeof c.must !== "number")
    return { valid: false, mustCount: -1, error: "missing must count" };

  let totalMust = 0;
  for (const k of expectedAxes) {
    const items = (r.axes as Record<string, unknown>)[k] as Array<Record<string, unknown>>;
    for (const item of items) {
      if (item.severity === "must") totalMust++;
    }
  }
  if (totalMust !== c.must)
    return {
      valid: false,
      mustCount: c.must,
      error: `must count mismatch: counts.must=${c.must}, actual=${totalMust}`,
    };

  return { valid: true, mustCount: c.must };
}

/**
 * 完了済みの review_work 試行数を workflow DB から数える（レビューラウンド算出用）。
 *
 * tado ADR-0003 で PromptCtx.previousAttempts が削除されたため、エンジンの
 * ボイラープレートに頼らず、セッション DB を直接参照する。tado のセッション
 * DB は共有の ~/.tado/workflow.db（TADO_HOME で上書き可）にあり、セッション
 * ディレクトリには置かれない。なお PromptCtx.sessionId は tado が値を設定
 * しないため、sessionDir の basename（= セッション ID）から導出する。
 */
function getWorkflowDbPath(): string {
  const os = require("node:os") as { homedir: () => string };
  const configuredHome = process.env.TADO_HOME?.trim();
  const home = configuredHome || os.homedir();
  return join(home, ".tado", "workflow.db");
}

function countReviewRounds(sessionDir: string): number {
  const fs = require("node:fs");
  const dbPath = getWorkflowDbPath();
  if (!fs.existsSync(dbPath)) return 0;

  const sessionId = basename(sessionDir);
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => {
      query: (sql: string) => { get: (params?: unknown[]) => JsonRecord | undefined };
      run: (sql: string, params?: unknown[]) => void;
      close: () => void;
    };
  };
  const db = new Database(dbPath);
  try {
    const row = db
      .query(
        "SELECT COUNT(*) AS cnt FROM step_attempts WHERE ended_at IS NOT NULL AND step_id = (SELECT id FROM steps WHERE session_id = ? AND step_key = 'review_work')",
      )
      .get(sessionId);
    return typeof row?.cnt === "number" ? row.cnt : 0;
  } finally {
    db.close();
  }
}

function findArtifactText(artifacts: ArtifactRecord[], key: string): string | undefined {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) return undefined;
  const fs = require("node:fs");
  try {
    return fs.readFileSync(match.filePath, "utf-8") as string;
  } catch {
    return undefined;
  }
}

const REVIEW_JSON_KEY = "agent-review.json";

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
            "1. **agent-review.json の must 指摘**（review_work の SubAgent レビューで検出された必須修正）",
            "2. **agent-review.json の should 指摘**（start_hunk_review で `[question]` として提示されたもの）",
            "3. **agent-review.json の want 指摘のうち人間コメントが付いたもの**（hunk コメント一覧で同一 newLine に user コメントが存在する want のみ）",
            "4. **hunk の blocking_threads**（人間が hunk TUI で追加した user コメントを含む `hunk-check.json`）",
            "",
            "各ソースの存在確認:",
            "- セッションディレクトリの `agent-review.json` を読み、must / should / want の全指摘を抽出する",
            "- セッションディレクトリの `hunk-check.json` を読み、`blocking_threads[].body` と `blocking_threads[].replies[]` を抽出する",
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
            "  - 修正指示（再実行時のみ: agent-review.json、hunk-check.json の blocking_threads / user コメントの該当指摘）",
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
    // Step 4: レビュー（SubAgent による客観レビュー）
    // -------------------------------------------------------------------
    {
      key: "review_work",
      phase: "レビュー",
      type: "task",
      maxRetries: 0,
      onFail: { action: "goto", target: "execute_work", requeueSource: true },
      task: {
        action: "run_subagent",
        subagentType: "mt-plan-work-reviewer",
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const collectScriptPath = join(import.meta.dir, "mt-plan-collect-review-context.ts");
          const jsonPath = join(ctx.sessionDir, "agent-review.json");
          const mdPath = join(ctx.sessionDir, "agent-review.md");
          const prevRound = countReviewRounds(ctx.sessionDir);
          const nextRound = prevRound + 1;

          return [
            "## 目的",
            "",
            "専用のレビュアー SubAgent に委譲し、5 観点で客観レビューを行う。",
            "",
            "## 手順",
            "",
            "### 1. 証拠収集（スクリプト実行）",
            "",
            "```bash",
            `bun run ${collectScriptPath} --plan-number <plan_number> --session-dir ${ctx.sessionDir}`,
            "```",
            "",
            "<plan_number> は workflow.db に保存した plan_number を使用する。",
            "",
            "### 2. SubAgent 委譲",
            "",
            `Task ツールで subagent_type = "mt-plan-work-reviewer" を指定し、以下を指示する:`,
            "",
            "- セッションディレクトリから `issue-body.md`、`git-branch-diff.txt`、`git-unstaged-diff.txt` を読み込む",
            "- 5 観点でレビューし、agent-review.json スキーマの JSON を返す",
            `- round 番号は ${nextRound} で、前回レビューからの差分に注目する（初回は全量レビュー）`,
            "",
            "### 3. 結果の保存",
            "",
            `SubAgent から返却された JSON を ${jsonPath} に書き出す。`,
            `必要に応じて人間可読版を ${mdPath} に書き出す。`,
            "",
            "### 4. report",
            "",
            "artifacts に以下を含めて report する:",
            "```json",
            `{"key": "agent-review.json", "path": "${jsonPath}"}`,
            "```",
            "",
            "## レビュー観点（SubAgent に委譲）",
            "",
            "1. **本質性・効率性 (essentiality):** 目的に対して本質的で効率的な解決となっているか",
            "2. **完了条件の充足 (acceptance):** `## ✅ 完了条件` は完全に満たせているか",
            "3. **スコープの遵守 (scope):** スコープ外の対応はしていないか",
            "4. **方針との整合 (alignment):** `## 🧭 方針` から大きく外れた対応はしていないか",
            "5. **アウトプットの品質 (quality):** `## 📦 アウトプット` の品質は問題ないか",
            "",
            "## 出力スキーマ",
            "",
            "```json",
            "{",
            `  "round": ${nextRound},`,
            '  "axes": {',
            '    "essentiality": [{"severity": "must|should|want", "detail": "..."}],',
            '    "acceptance": [...],',
            '    "scope": [...],',
            '    "alignment": [...],',
            '    "quality": [...]',
            "  },",
            '  "counts": {"must": <N>, "should": <N>, "want": <N>}',
            "}",
            "```",
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        const raw = findArtifactText(ctx.artifacts, REVIEW_JSON_KEY);
        const result = validateReviewJson(raw);
        if (!result.valid) {
          return { status: "error", reasons: [result.error ?? "validation failed"] };
        }
        if (result.mustCount > 0) {
          return { status: "fail", reasons: [`must: ${result.mustCount} items`] };
        }
        return { status: "pass", reasons: ["must: 0"] };
      },
    },

    // -------------------------------------------------------------------
    // Step 5: hunk レビュー起動
    // -------------------------------------------------------------------
    {
      key: "start_hunk_review",
      phase: "hunk レビュー起動",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const reviewRaw =
            findArtifactText(ctx.artifacts, REVIEW_JSON_KEY) ??
            readSessionFile(ctx.sessionDir, REVIEW_JSON_KEY);
          const comments = buildHunkComments(reviewRaw);
          const commentsPath = join(ctx.sessionDir, HUNK_COMMENTS_KEY);
          const startPath = join(ctx.sessionDir, HUNK_START_KEY);

          return [
            "## 目的",
            "",
            "レビュー結果を hunk の comment apply 形式へ変換し、アクティブな hunk セッションに注入する。",
            "このステップは起動とコメント注入だけを担当し、レビューの待機・ゲート判定・修正は行わない。",
            "",
            "## 入力からコメントへの変換",
            "",
            `agent-review.json（${join(ctx.sessionDir, REVIEW_JSON_KEY)}）の axes を読み、各項目を hunk の comment apply 形式（{filePath, newLine|oldLine, summary, markup}）に変換する。formatComment 純粋関数で STML（markup）と fallback（summary）を二重生成する:`,
            "- severity: 🚨 must / ⚠️ should / 💡 want、taxonomy: 🐛 issue（must）/ 🙋 question（should/want）、axis: 🎯 essentiality / ✅ acceptance / 📦 scope / 🧭 alignment / ✨ quality を box title `🚨 must · 🐛 issue · ✅ acceptance` に併記",
            "- summary: `🚨 must · 🐛 issue · ✅ acceptance | path:line — 詳細先頭` 形式（`[]` を用いない）",
            "- markup: STML の <box> で 4 ブロック（ヘッダ=title、対象ファイル/行、詳細本文、任意の提案リスト）を構造化。`hunk diff --experimental` で STML が描画され、非対応環境では summary が graceful fallback される",
            "",
            "- `filePath` はリポジトリルートからの相対パスで必ず含める。ファイルに紐づかない指摘はファイルレベル指摘として代表ファイル（例: CONTEXT.md）に紐づける",
            '- 特定行への指摘は `position`（{side: "new"|"old", line}）を `newLine` / `oldLine` に変換して含める',
            "- 行指定のない指摘は `newLine` を省略する（`mt hunk start` が `newLine: 1` に合成する）",
            "- `type` や reply は生成しない",
            "",
            "今回生成する apply 配列（変換後の正確な JSON）:",
            "```json",
            JSON.stringify(comments, null, 2),
            "```",
            "",
            "## 手順",
            "",
            `1. 上記の配列を ${commentsPath} に JSON として保存する（空配列でも保存する）。`,
            "2. アクティブな hunk セッションを確認する:",
            "```bash",
            "mt hunk status",
            "```",
            '- "hunk review session: active" なら次へ進む。',
            '- "none" または "stale" なら hunk TUI セッションがない。ユーザーにターミナルで `hunk diff <base-branch>` を開いてもらい、セッションが active になってからこのステップを再実行する。',
            "- ベースブランチは `origin/HEAD` があればその参照名から `origin/` を除き、取得できなければ `main` を使う:",
            "```bash",
            `BASE_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"`,
            'BASE_BRANCH="${BASE_BRANCH:-main}"',
            "```",
            "3. stdin からコメント JSON を渡し、`mt hunk start` を実行する:",
            "```bash",
            `cat "${commentsPath}" | mt hunk start | tee "${startPath}"`,
            "```",
            "4. start の stdout（`session` と `comments`）を確認し、hunk TUI に表示されたコメント数として報告する。",
            "",
            "## report",
            "",
            '成功時は `status: "completed"` とし、artifacts に以下を含める:',
            "```json",
            `[{"key":"${HUNK_COMMENTS_KEY}","path":"${commentsPath}"},{"key":"${HUNK_START_KEY}","path":"${startPath}"}]`,
            "```",
            "",
            "レビューセッションの終了処理や standalone レビューの実行はこのステップの責務外とする。",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (ctx.attemptResult.status !== "completed") {
          return { status: "error", reasons: [ctx.attemptResult.errors ?? "hunk start failed"] };
        }
        // 偽装 artifact（{"session":null}）を弾く: start の stdout に session が
        // 含まれていることと、daemon 上でセッションが active であることを検証する
        const raw =
          findArtifactText(ctx.artifacts, HUNK_START_KEY) ??
          readSessionFile(ctx.sessionDir, HUNK_START_KEY);
        const started = findJsonObject(raw);
        if (!started || started.session === null || started.session === undefined) {
          return {
            status: "fail",
            reasons: [
              `${HUNK_START_KEY} has no session. hunk セッションを active にして \`mt hunk start\` を再実行してください`,
            ],
          };
        }
        if (!isHunkSessionActive()) {
          return {
            status: "fail",
            reasons: ["hunk session is not active according to `mt hunk status`"],
          };
        }
        return { status: "pass", reasons: ["hunk review started with an active session"] };
      },
    },

    // -------------------------------------------------------------------
    // Step 6: hunk レビュー待機
    // -------------------------------------------------------------------
    {
      key: "await_review",
      phase: "hunk レビュー待機",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "escalate" },
      humanGate: {
        presentArtifacts: [HUNK_START_KEY, HUNK_COMMENTS_KEY, REVIEW_JSON_KEY],
        choices: [
          {
            value: "approve",
            label: "レビュー完了",
            desc: "hunk TUI でコメントの確認・user コメントの追加を終え、ゲート判定へ進む",
          },
          { value: "abort", label: "中断" },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => {
        // 人間承認の偽装を検出する: 承認時点でも daemon 上でセッションが
        // active であることを再検証する（ADR-0016）
        if (!isHunkSessionActive()) {
          return {
            status: "fail",
            reasons: [
              "hunk session is not active. `hunk diff <base-branch>` を再起動してから approve を選択してください",
            ],
          };
        }
        return { status: "pass", reasons: ["hunk session is still active"] };
      },
    },

    // -------------------------------------------------------------------
    // Step 7: hunk ゲート判定
    // -------------------------------------------------------------------
    {
      key: "check_hunk",
      phase: "hunk ゲート判定",
      type: "task",
      maxRetries: 0,
      onFail: { action: "goto", target: "execute_work", requeueSource: true },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const checkPath = join(ctx.sessionDir, HUNK_CHECK_KEY);
          return [
            "## 目的",
            "",
            "hunk 上のレビューを機械的に判定し、未解決のコメントがあれば execute_work に修正ソースとして渡す。",
            "このステップではゲート判定コマンドだけを呼び、standalone レビューや終了処理は行わない。",
            "",
            "## 手順",
            "",
            "1. `mt hunk check` を実行する。exit 0 = 通過、exit 1 = ブロック。exit 1 は未解決コメントによる通常のブロックなので、コマンド失敗として握り潰さず stdout JSON を取得する。",
            '2. stdout の passes / blocking_threads JSON（例: {"passes":..., "blocking_threads":[...]}）をそのまま保存する。blocking thread の `body` は原文（人間コメントを含む）のまま一字一句保持し、taxonomy（"issue" / "question" / "human"）も変更しない。`replies` は hunk がフラット構造のため常に空配列になる。',
            `3. JSON を ${checkPath} に保存し、同じ JSON を report の subagentOutput として返す。`,
            "",
            "```json",
            '{"passes":false,"blocking_threads":[{"id":"...","file":"...","line":1,"taxonomy":"question","body":"[question] ...","replies":[]}]}',
            "```",
            "",
            "passes が false の場合も task 自体は実行成功として report する。workflow の check 関数が `mt hunk check` を daemon から再実行し、report / artifact の JSON と passes・blocking_threads が一致することを検証する（不一致は偽装として fail）。一致した場合は blocking_threads を確認して execute_work → ensure_hunk_session → review_work → start_hunk_review → await_review → check_hunk の修正ループへ戻す。passes が true の場合だけ finalize_done へ進む。",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        // daemon から再取得する。exit 1 は未解決コメントによる通常のブロックで、
        // stdout に gate JSON を出力するため throw せず回収する（runHunkCommand）
        const daemon = parseHunkCheck(runHunkCommand(["check"]));
        if (!daemon) {
          return {
            status: "error",
            reasons: ["mt hunk check daemon output is not valid gate JSON"],
          };
        }

        // 偽装検出: report / artifact の gate JSON と daemon 真理を突合する。
        // want のみでは fail させない（passes / blocking_threads の一致判定に含まれる）
        const reported =
          parseHunkCheck(ctx.attemptResult.subagentOutput) ??
          parseHunkCheck(findArtifactText(ctx.artifacts, HUNK_CHECK_KEY));
        if (!reported) {
          return { status: "error", reasons: ["report/artifact has no valid gate JSON"] };
        }
        if (
          daemon.passes !== reported.passes ||
          JSON.stringify(daemon.blocking_threads) !== JSON.stringify(reported.blocking_threads)
        ) {
          return {
            status: "fail",
            reasons: [
              "reported gate JSON does not match `mt hunk check` daemon output. `mt hunk check` を再実行し、stdout の JSON をそのまま report してください",
            ],
          };
        }

        const fs = require("node:fs");
        try {
          fs.writeFileSync(
            join(ctx.sessionDir, HUNK_CHECK_KEY),
            `${JSON.stringify(daemon, null, 2)}\n`,
            "utf-8",
          );
        } catch (error) {
          return {
            status: "error",
            reasons: [`failed to persist hunk check output: ${String(error)}`],
          };
        }

        if (daemon.passes) return { status: "pass", reasons: ["hunk gate passes"] };
        try {
          resetReviewCycle(ctx.sessionDir);
        } catch (error) {
          return {
            status: "error",
            reasons: [`failed to reset hunk review cycle: ${String(error)}`],
          };
        }
        const reasons = daemon.blocking_threads.map((thread) => {
          const replies =
            thread.replies && thread.replies.length > 0
              ? `; replies: ${thread.replies.join(" | ")}`
              : "";
          return `${thread.taxonomy ?? "blocking"} ${thread.file ?? "(file-level)"}: ${thread.body}${replies}`;
        });
        return { status: "fail", reasons: reasons.length > 0 ? reasons : ["hunk gate is blocked"] };
      },
    },

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
