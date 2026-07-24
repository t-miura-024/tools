import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ConditionCtx,
  ArtifactRecord,
} from '../mt-workflow/types';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../mt-plan/init-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findArtifactText(artifacts: ArtifactRecord[], key: string): string | undefined {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) return undefined;
  try {
    return readFileSync(match.filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

interface PrepareDecision {
  mode: 'update' | 'decompose';
  fromIssue: boolean;
  issueNumber?: number;
  repo?: string;
}

function readPrepareDecision(artifacts: ArtifactRecord[]): PrepareDecision | undefined {
  const raw = findArtifactText(artifacts, PREPARE_DECISION_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PrepareDecision;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREPARE_DECISION_KEY = 'prepare-decision.json';
const mtPlanDir = join(import.meta.dir, '..', 'mt-plan');

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

const def: WorkflowDef = {
  id: 'mt-create-plan',

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
    // -----------------------------------------------------------------
    // Step 1: Grill Phase
    // -----------------------------------------------------------------
    {
      key: 'grill',
      phase: 'Grill Phase',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画の全側面についてユーザーと共通認識に達するまで質問を繰り返す（Grill Phase）。',
            '',
            '## 手順',
            '',
            '### 1. from-Issue フローの確認',
            '',
            'ユーザーに「既存 Issue を取り込みますか？」と確認する。',
            '- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、Grill Phase の素材として使う',
            '- No の場合: 新規計画として Grill Phase を開始する',
            '',
            '### 2. Grill Phase 本体',
            '',
            '質問は一度に 1 つ。ユーザーが「十分」と宣言するまで継続する。',
            '',
            '- **ユーザー決定領域:** 背景、why、意図、制約 — 推測で埋めず質問で確認',
            '- **AI 提案領域:** 完了条件、アウトプット、方針、解決策、実行単位の分割 — 選択肢・推奨度・理由を添えて提案',
            '- 文書を残しながら詰める場合は `mt-grill-with-docs` を使う（用語は `CONTEXT.md`、覆しにくい判断は ADR）',
            '',
            '### 3. 縦切り分解の検討',
            '',
            '大きな計画を実行可能な単位へ割る場合は、次を守る:',
            '- 各単位は 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする',
            '- 単独で確認できる振る舞いを持つ',
            '- 依存する他単位を `Blocked by` として明示する',
            '',
            '### 4. 最終本文の確定',
            '',
            `plan-format.md（${join(mtPlanDir, 'plan-format.md')}）に従い、Issue body の最終本文を確定する。`,
            '確定した本文をセッションディレクトリに `issue-body.md` として書き出す。',
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "issue-body.md", "path": "${ctx.sessionDir}/issue-body.md"}`,
            '```',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 2: 起票準備
    // -----------------------------------------------------------------
    {
      key: 'prepare',
      phase: '起票準備',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '起票に必要な環境整備（repo 決定、label 確認）を行い、分解要否の判定材料を artifact に書き出す。',
            '',
            '## 手順',
            '',
            '### 1. 対象 repo の決定',
            '',
            '```bash',
            'gh repo view --json nameWithOwner',
            '```',
            '',
            '- owner が `t-miura-024` → そのまま',
            '- それ以外 → `t-miura-024/note` + `external/<repo>` label',
            '',
            '### 2. label の確認・自動作成',
            '',
            '`kind/plan` label がなければ自動作成。`external/<repo>` label も同様（冪等に）。',
            '',
            '```bash',
            'gh label list --search "kind/plan" --json name',
            'gh label create "kind/plan" --description "計画 Issue" --color "0075ca" 2>/dev/null || true',
            '```',
            '',
            '### 3. 分解要否の判定',
            '',
            'Grill Phase で確定した本文（`issue-body.md`）を確認し、以下を判定する:',
            '',
            '- 計画が複数の機能・領域を含み、単一 Issue では独立した完了条件と進捗を管理できない場合 → `mode: "decompose"`',
            '- それ以外 → `mode: "update"`',
            '',
            'from-Issue フローの場合は既存 Issue 番号も記録する。',
            '',
            '### 4. 判定結果の書き出し',
            '',
            `判定結果を ${ctx.sessionDir}/prepare-decision.json に書き出す:`,
            '',
            '```json',
            '{',
            '  "mode": "update" | "decompose",',
            '  "fromIssue": true | false,',
            '  "issueNumber": <number | null>,',
            '  "repo": "<owner>/<repo>"',
            '}',
            '```',
            '',
            '### 5. 起票案の提示',
            '',
            '分解する場合は、親・子の計画案（各子の目的・対応スコープ）を提示する準備をする。',
            '- 子計画は 1 階層までとし、再分解しない',
            '- 子の目的・対応スコープの和集合が親計画を過不足なく満たすことを確認する',
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "prepare-decision.json", "path": "${ctx.sessionDir}/prepare-decision.json"}`,
            '```',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 3: 分解判定ゲート
    // -----------------------------------------------------------------
    {
      key: 'decompose_gate',
      phase: '分解判定・起票承認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'abort' },
      humanGate: {
        presentArtifacts: [PREPARE_DECISION_KEY],
        choices: [
          { value: 'approve', label: '承認する', desc: '提示された起票案（分解要否を含む）で進める' },
          { value: 'revise', label: '修正する', desc: 'Grill Phase に戻って内容を再検討する' },
          { value: 'abort', label: '中断' },
        ],
        reviseTargetStep: 'grill',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 4: Issue 更新（分解しない場合）
    // -----------------------------------------------------------------
    {
      key: 'update_issue',
      phase: 'Issue 作成・更新',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'escalate' },
      condition: (ctx: ConditionCtx): boolean => {
        const decision = readPrepareDecision(ctx.artifacts);
        return decision?.mode !== 'decompose';
      },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画 Issue を作成または更新する（分解しない単一 Issue の場合）。',
            '',
            '## 手順',
            '',
            '### 1. prepare-decision.json の読み込み',
            '',
            `セッションディレクトリの prepare-decision.json を読み、fromIssue / issueNumber / repo を確認する。`,
            '',
            '### 2a. from-Issue フロー（既存 Issue を更新）',
            '',
            '既存 Issue の body を `gh issue view <number> --json body` で取得し、確定した本文で更新する:',
            '',
            '```bash',
            `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
            '```',
            '',
            '**重要:** 新規作成せず、必ず既存 Issue を更新すること。',
            '',
            '### 2b. 新規作成フロー',
            '',
            `plan-format.md（${join(mtPlanDir, 'plan-format.md')}）に従い Issue body を組み立て、作成する:`,
            '',
            '```bash',
            'gh issue create --title "<title>" --body-file ' + ctx.sessionDir + '/issue-body.md --label "kind/plan"',
            '```',
            '',
            '### 3. Project への追加',
            '',
            'Issue を GitHub Project に追加する（Status は `draft` に設定）:',
            '',
            '```bash',
            'gh project item-add <project-number> --owner <owner> --url <issue-url>',
            '```',
            '',
            '### 4. Issue 番号の記録',
            '',
            '作成・更新した Issue 番号を記録する。',
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
            '```',
            '',
            'issue-number.txt には Issue 番号のみを記載する。',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 5: Sub Issue 作成（分解する場合）
    // -----------------------------------------------------------------
    {
      key: 'create_sub_issues',
      phase: 'Sub Issue 作成',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'escalate' },
      condition: (ctx: ConditionCtx): boolean => {
        const decision = readPrepareDecision(ctx.artifacts);
        return decision?.mode === 'decompose';
      },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画を分解し、親 Issue と子 Issue（Sub Issue）を作成する。',
            '',
            '## 手順',
            '',
            '### 1. prepare-decision.json の読み込み',
            '',
            'セッションディレクトリの prepare-decision.json を読み、fromIssue / issueNumber / repo を確認する。',
            '',
            '### 2. 親 Issue の作成または更新',
            '',
            '#### 2a. from-Issue フロー（既存 Issue が親になる）',
            '',
            '既存 Issue の body を確定した親本文で更新する:',
            '',
            '```bash',
            `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
            '```',
            '',
            '**重要:** 新規作成せず、必ず既存 Issue を更新すること。',
            '',
            '#### 2b. 新規作成フロー',
            '',
            '```bash',
            'gh issue create --title "<親タイトル>" --body-file ' + ctx.sessionDir + '/issue-body.md --label "kind/plan"',
            '```',
            '',
            '### 3. 子 Issue の作成',
            '',
            '各子計画について Issue を作成する（すべて `kind/plan` label + draft）:',
            '',
            '```bash',
            'gh issue create --title "<子タイトル>" --body-file <child-body-file> --label "kind/plan"',
            '```',
            '',
            '- 子計画は 1 階層までとし、再分解しない',
            '- 子の目的・対応スコープの和集合が親計画を過不足なく満たすこと',
            '',
            '### 4. Sub Issue 関係の設定',
            '',
            'GitHub REST API で親子関係を設定する:',
            '',
            '```bash',
            'gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \\',
            '  -f sub_issue_id=<child-issue-id>',
            '```',
            '',
            '### 5. Project への追加',
            '',
            '親子すべてを GitHub Project に追加する（Status は `draft`）。',
            '',
            '### 6. Issue 番号の記録',
            '',
            '親 Issue 番号を記録する。',
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
            '```',
            '',
            'issue-number.txt には親 Issue 番号のみを記載する。',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 6: refined 昇格確認ゲート
    // -----------------------------------------------------------------
    {
      key: 'refined_gate',
      phase: 'refined 昇格確認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'abort' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: 'refined へ昇格する', desc: '内容が完成・実行可能。refined へ昇格して完了する' },
          { value: 'revise', label: '修正する', desc: 'Grill Phase に戻って内容を再検討する' },
          { value: 'abort', label: 'draft のまま中断', desc: 'draft のまま残してセッションを終了する' },
        ],
        reviseTargetStep: 'grill',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 7: 完了処理
    // -----------------------------------------------------------------
    {
      key: 'finalize',
      phase: '完了処理',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画 Issue を refined に昇格し、作成内容を報告する。',
            '',
            '## 手順',
            '',
            '### 1. Issue 番号の確認',
            '',
            `セッションディレクトリの issue-number.txt から Issue 番号を読み取る。`,
            '',
            '### 2. refined への昇格',
            '',
            '```bash',
            `bun run ${join(mtPlanDir, 'transition-plan.ts')} <number> refined`,
            '```',
            '',
            'このコマンドは以下を自動実行する:',
            '- GitHub Project の Status を `refined` に更新',
            '- `## 🐢 履歴` へ遷移エントリを追記',
            '- 分解計画の場合は子を refined に遷移すると親も自動集約される',
            '',
            '### 3. 作成内容の報告',
            '',
            '以下を報告する:',
            '- Issue URL・番号',
            '- 対象 repo',
            '- Project・Status',
            '- label',
            '- refined の場合: `mt-run-plan` で実行可能であることを案内',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },
  ],
};

export default def;
