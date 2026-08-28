import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult, InitCtx, ArtifactRecord } from "tado";
import { join, resolve } from "node:path";
import fs from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadConfig } from "../_shared/mt-plan-init-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPathInside(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  let realBase: string;
  try {
    realBase = fs.realpathSync(normalizedBase);
  } catch {
    realBase = normalizedBase;
  }
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(normalizedTarget);
  } catch {
    try {
      const sep = normalizedTarget.lastIndexOf("/");
      const parent = sep > 0 ? normalizedTarget.slice(0, sep) : sep === 0 ? "/" : ".";
      const realParent = fs.realpathSync(parent);
      const rest = normalizedTarget.slice(parent.length);
      realTarget = realParent + rest;
    } catch {
      realTarget = normalizedTarget;
    }
  }
  return realTarget === realBase || realTarget.startsWith(realBase + "/");
}

function findArtifactText(artifacts: ArtifactRecord[], key: string): string {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) throw new Error(`Artifact not found: ${key}`);
  const resolved = resolve(match.filePath);
  if (match.filePath.includes("..")) {
    throw new Error(`path traversal detected: ${match.filePath}`);
  }
  if (!isPathInside(process.cwd(), resolved) && resolved.includes("..")) {
    throw new Error(`path traversal detected: ${match.filePath}`);
  }
  return readFileSync(resolved, "utf-8");
}

// oxlint-disable-next-line no-unused-vars
function readSessionFile(sessionDir: string, fileName: string): string | undefined {
  const fullPath = join(sessionDir, fileName);
  if (!isPathInside(sessionDir, fullPath)) {
    throw new Error(`path traversal detected: ${fullPath}`);
  }
  try {
    return fs.readFileSync(fullPath, "utf-8") as string;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return undefined;
    throw e;
  }
}

interface RepoInfo {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

function readRepoInfo(artifacts: ArtifactRecord[]): RepoInfo {
  const raw = findArtifactText(artifacts, REPO_INFO_KEY);
  return JSON.parse(raw) as RepoInfo;
}

function isTMiura024(artifacts: ArtifactRecord[]): boolean {
  return readRepoInfo(artifacts).owner === "t-miura-024";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREPARE_DECISION_KEY = "prepare-decision.json";
const ISSUE_BODY_KEY = "issue-body.md";
const GRILL_MAP_KEY = "grill-map.md";
const REPO_INFO_KEY = "repo-info.json";
const mtGrillRoundsDir = join(import.meta.dir, "..", "mt-grill-rounds");
const mtDomainModelingDir = join(import.meta.dir, "..", "mt-domain-modeling");

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

const def: WorkflowDef = {
  id: "mt-plan-create",
  description:
    "GitHub Issueとして計画を新規作成・リファインメントするワークフロー。from-Issue取り込みとGrillヒアリングを経てDraft Issueを起票する。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
  },

  afterInit: async (ctx: InitCtx) => {
    const stdout = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
      encoding: "utf-8",
    }).trim();
    const [owner, repo] = stdout.split("/");
    const repoInfo: RepoInfo = { owner, repo, nameWithOwner: stdout };
    const repoInfoPath = join(ctx.sessionDir, REPO_INFO_KEY);
    writeFileSync(repoInfoPath, JSON.stringify(repoInfo, null, 2), "utf-8");
    return { artifacts: [{ key: REPO_INFO_KEY, path: repoInfoPath }] };
  },

  steps: [
    // -----------------------------------------------------------------
    // Step 1: Grill Phase
    // -----------------------------------------------------------------
    {
      key: "grill",
      phase: "Grill Phase",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const withDocs = isTMiura024(ctx.artifacts);
          const grillMapPath = join(ctx.sessionDir, GRILL_MAP_KEY);

          const hearingSection = withDocs
            ? [
                "### 2. 徹底ヒアリング + ドメインモデリング",
                "",
                `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                "",
                `加えて mt-domain-modeling スキル（${join(mtDomainModelingDir, "SKILL.md")}）を参照し、その規律をすべて適用する。`,
                "",
                "**重要:** repo へのファイル書き込み（CONTEXT.md の更新、ADR ファイルの作成）は禁止。",
                "確定した用語・ADR 案はすべてライブ地図の `## 確定用語` / `## ADR 案` セクションに記録すること。",
                `フォーマットは ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} / ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従う。`,
              ]
            : [
                "### 2. 徹底ヒアリング",
                "",
                `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
              ];

          return [
            "## 目的",
            "",
            "計画の全側面についてユーザーと共通認識に達するまでヒアリングを行う（Grill Phase）。",
            "",
            "## 手順",
            "",
            "### 1. from-Issue フローの確認",
            "",
            "ユーザーに「既存 Issue を取り込みますか？」と確認する。",
            "- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う",
            "- No の場合: 新規計画としてヒアリングを開始する",
            "",
            ...hearingSection,
            "",
            "ヒアリングは mt-grill-rounds の方式に従って進める:",
            `- ライブ地図のパスは既定パスではなく \`${grillMapPath}\`（セッションディレクトリ配下）を明示的に指定し、このパスで地図を育成する`,
            "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
            "- 回答をライブ地図へ反映した後にフロンティアを再計算し、次のラウンドを提示する",
            "- フロンティアが空になり、ユーザーが共通認識を確認するまでラウンドを継続する",
            "",
            "### 3. ライブ地図の最終確認",
            "",
            `ヒアリングの全決定がセッションディレクトリのライブ地図 \`${grillMapPath}\` に蒸留されていることを確認する。`,
            "地図は Markdown 入れ子リスト＋状態マーカー（`[確定]` / `[未決]` / `[保留]`）の単一ファイルとし、質疑ログなどの別ファイルは残さない。",
            ...(withDocs
              ? [
                  "ドメインモデリングで確定した用語・ADR 案が `## 確定用語` / `## ADR 案` セクションに記録されていることも確認する。",
                ]
              : []),
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "${GRILL_MAP_KEY}", "path": "${grillMapPath}"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 2: 本文マッピング
    // -----------------------------------------------------------------
    {
      key: "draft_body",
      phase: "本文マッピング",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const withDocs = isTMiura024(ctx.artifacts);

          return [
            "## 目的",
            "",
            "ヒアリングで集まった情報を plan-format.md のテンプレートにマッピングし、Issue body の最終本文を確定する。",
            "分解モードの場合は子 Issue の body もすべてこのステップで生成する。",
            "",
            "## 手順",
            "",
            "### 1. ヒアリング結果の読み込み",
            "",
            `セッションディレクトリの \`${GRILL_MAP_KEY}\`（ライブ地図）を読み込む。`,
            "from-Issue フローの場合は既存 Issue の内容も合わせて参照する。",
            "",
            ...(withDocs
              ? [
                  "### 2. ドキュメントの整形・埋め込み",
                  "",
                  `Grill Phase で \`${GRILL_MAP_KEY}\` の \`## 確定用語\` / \`## ADR 案\` セクションに記録された確定用語・ADR 案は確定済みとして扱う。要否の再判断はしない。`,
                  "",
                  "以下を行い、plan-format.md の `## 📄 ドキュメント` セクションに埋め込む:",
                  `- CONTEXT は ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} に従い本文を整形する`,
                  `- ADR は ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従い本文を整形する`,
                  "- ADR 連番は対象 repo の `docs/adr/` を確認して次番号を確定する",
                  "- セクション形式: `### <リポジトリ相対パス>` + コードフェンス全文",
                  "",
                ]
              : []),
            "",
            `### ${withDocs ? "3" : "2"}. 縦切り分解の検討`,
            "",
            "大きな計画を実行可能なミッションへ割る場合は、次を守る:",
            "- 各ミッションは 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする",
            "- 単独で確認できる振る舞いを持つ",
            "- 依存関係は実行順の Wave 配置で表現する（plan-format.md の `### 実行順` 参照）",
            "",
            `### ${withDocs ? "4" : "3"}. 最終本文の確定`,
            "",
            `plan-format.md（${join(import.meta.dir, "..", "_shared", "mt-plan-plan-format.md")}）に従い、Issue body の最終本文を確定する。`,
            `確定した本文をセッションディレクトリに \`${ISSUE_BODY_KEY}\` として書き出す。`,
            "",
            "分解モードの場合:",
            "- 親 Issue の body を `issue-body.md` として書き出す",
            "- 各子計画の body を `issue-body-<n>.md`（n = 1, 2, 3...）として書き出す",
            "- ドキュメントセクション（`## 📄 ドキュメント`）は対応する子計画の body に配置し、親には残さない",
            "- 子計画は 1 階層までとし、再分解しない",
            "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすこと",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "${ISSUE_BODY_KEY}", "path": "${join(ctx.sessionDir, ISSUE_BODY_KEY)}"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 3: 起票準備
    // -----------------------------------------------------------------
    {
      key: "prepare",
      phase: "起票準備",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const repoInfo = readRepoInfo(ctx.artifacts);

          return [
            "## 目的",
            "",
            "起票に必要な環境整備（label 確認）を行い、分解要否の判定材料を artifact に書き出す。",
            "",
            "## 手順",
            "",
            "### 1. 対象 repo の確認",
            "",
            `対象 repo: \`${repoInfo.nameWithOwner}\`（afterInit で取得済み）`,
            "",
            "- owner が `t-miura-024` → そのまま",
            "- それ以外 → `t-miura-024/note` + `external/<repo>` label",
            "",
            "### 2. label の確認・自動作成",
            "",
            "`kind/plan` label がなければ自動作成。`external/<repo>` label も同様（冪等に）。",
            "",
            "```bash",
            'gh label list --search "kind/plan" --json name',
            'gh label create "kind/plan" --description "計画 Issue" --color "0075ca" 2>/dev/null || true',
            "```",
            "",
            "### 3. 分解要否の判定",
            "",
            `Grill Phase で確定した内容（ライブ地図 \`${GRILL_MAP_KEY}\`）を確認し、以下を判定する:`,
            "",
            '- 計画が複数の機能・領域を含み、単一 Issue では独立した完了条件と進捗を管理できない場合 → `mode: "decompose"`',
            '- それ以外 → `mode: "update"`',
            "",
            "from-Issue フローの場合は既存 Issue 番号も記録する。",
            "",
            "### 4. 判定結果の書き出し",
            "",
            `判定結果を ${ctx.sessionDir}/prepare-decision.json に書き出す:`,
            "",
            "```json",
            "{",
            '  "mode": "update" | "decompose",',
            '  "fromIssue": true | false,',
            '  "issueNumber": <number | null>,',
            '  "repo": "<owner>/<repo>"',
            "}",
            "```",
            "",
            "### 5. 起票案の提示",
            "",
            "分解する場合は、親・子の計画案（各子の目的・対応スコープ）を提示する準備をする。",
            "- 子計画は 1 階層までとし、再分解しない",
            "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすことを確認する",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "prepare-decision.json", "path": "${ctx.sessionDir}/prepare-decision.json"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 4: Draft Issue 作成・更新
    // -----------------------------------------------------------------
    {
      key: "create_draft",
      phase: "Draft Issue 作成",
      type: "task",
      maxRetries: 2,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "draft_body で生成した Issue body を使って Draft Issue を作成（または更新）する。",
            "コンテンツ生成は行わず、GitHub 操作のみに専念する。",
            "",
            "## 手順",
            "",
            "### 1. 入力情報の読み込み",
            "",
            `セッションディレクトリの \`${ISSUE_BODY_KEY}\` と \`${PREPARE_DECISION_KEY}\` を読み込む。`,
            "分解モードの場合は `issue-body-<n>.md` も読み込む。",
            "prepare-decision.json から mode / fromIssue / issueNumber / repo を確認する。",
            "",
            "### 2. Draft Issue の作成または更新",
            "",
            `セッションディレクトリに issue-number.txt が存在する場合（リトライ時）は、既存 Issue を \`gh issue edit\` で更新する。`,
            "存在しない場合は新規作成する。",
            "",
            "#### 2a. from-Issue フロー（既存 Issue を更新）",
            "",
            "```bash",
            `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
            "```",
            "",
            "**重要:** 新規作成せず、必ず既存 Issue を更新すること。",
            "",
            "#### 2b. 新規作成フロー（mode: update）",
            "",
            "```bash",
            `gh issue create --title "<title>" --body-file ${ctx.sessionDir}/issue-body.md --label "kind/plan"`,
            "```",
            "",
            "#### 2c. 分解モード（mode: decompose）",
            "",
            "親 Issue を作成（または from-Issue の場合は更新）した後、各子計画について Issue を作成する（すべて `kind/plan` label + draft）:",
            "",
            "```bash",
            `gh issue create --title "<子タイトル>" --body-file ${ctx.sessionDir}/issue-body-<n>.md --label "kind/plan"`,
            "```",
            "",
            "GitHub REST API で親子関係を設定する:",
            "",
            "```bash",
            "gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \\",
            "  -f sub_issue_id=<child-issue-id>",
            "```",
            "",
            "### 3. Project への追加",
            "",
            "Issue（分解モードの場合は親子すべて）を GitHub Project に追加する（Status は `draft` に設定）:",
            "",
            "```bash",
            "gh project item-add <project-number> --owner <owner> --url <issue-url>",
            "```",
            "",
            "### 4. Issue 番号の記録",
            "",
            "作成・更新した Issue 番号（分解モードの場合は親番号）を issue-number.txt に記録する。",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 5: レビューゲート
    // -----------------------------------------------------------------
    {
      key: "review_gate",
      phase: "レビュー",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      humanGate: {
        presentArtifacts: ["issue-number.txt"],
        choices: [
          {
            value: "approve",
            label: "refined へ昇格する",
            desc: "内容が完成・実行可能。refined へ昇格して完了する",
          },
          {
            value: "revise",
            label: "修正する",
            desc: "Grill Phase に戻って内容を再検討する（Draft Issue は残し、更新する）",
          },
          { value: "abort", label: "中断", desc: "Draft Issue を残してセッションを終了する" },
        ],
        reviseTargetStep: "grill",
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 6: 完了処理
    // -----------------------------------------------------------------
    {
      key: "finalize",
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
            "計画 Issue を refined に昇格し、作成内容を報告する。",
            "",
            "## 手順",
            "",
            "### 1. Issue 番号の確認",
            "",
            `セッションディレクトリの issue-number.txt から Issue 番号を読み取る。`,
            "",
            "### 2. refined への昇格",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "..", "_shared", "mt-plan-transition-plan.ts")} <number> refined`,
            "```",
            "",
            "このコマンドは以下を自動実行する:",
            "- GitHub Project の Status を `refined` に更新",
            "- `## 🐢 履歴` へ遷移エントリを追記",
            "- 分解計画の場合は子を refined に遷移すると親も自動集約される",
            "",
            "### 3. 作成内容の報告",
            "",
            "以下を報告する:",
            "- Issue URL・番号",
            "- 対象 repo",
            "- Project・Status",
            "- label",
            "- refined の場合: `mt-plan-run` で実行可能であることを案内",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join("\n");
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },
  ],
};

export default def;
