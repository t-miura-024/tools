import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ArtifactRecord,
} from 'tado';
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
const ISSUE_BODY_KEY = 'issue-body.md';
const GRILL_NOTES_KEY = 'grill-notes.md';
const mtPlanDir = join(import.meta.dir, '..', 'mt-plan');
const mtGrillMeDir = join(import.meta.dir, '..', 'mt-grill-me');
const mtGrillWithDocsDir = join(import.meta.dir, '..', 'mt-grill-with-docs');

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
            '計画の全側面についてユーザーと共通認識に達するまでヒアリングを行う（Grill Phase）。',
            '',
            '## 手順',
            '',
            '### 1. from-Issue フローの確認',
            '',
            'ユーザーに「既存 Issue を取り込みますか？」と確認する。',
            '- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う',
            '- No の場合: 新規計画としてヒアリングを開始する',
            '',
            '### 2. 徹底ヒアリング',
            '',
            `mt-grill-me スキル（${join(mtGrillMeDir, 'SKILL.md')}）をロードし、その指示に従ってヒアリングを行う。`,
            'ユーザーが「十分」と宣言するまで継続する。',
            '',
            '### 3. ヒアリング結果の記録',
            '',
            `ヒアリングで確定した内容・未決事項を自由形式でセッションディレクトリの \`${GRILL_NOTES_KEY}\` に書き出す。`,
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "${GRILL_NOTES_KEY}", "path": "${join(ctx.sessionDir, GRILL_NOTES_KEY)}"}`,
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
            `Grill Phase で確定した内容（\`${GRILL_NOTES_KEY}\`）を確認し、以下を判定する:`,
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
    // Step 3: Draft Issue 作成・更新
    // -----------------------------------------------------------------
    {
      key: 'create_draft',
      phase: 'Draft Issue 作成',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            'ヒアリング結果を plan-format.md のテンプレートにマッピングして Issue body を生成し、Draft Issue を作成（または更新）する。',
            '',
            '## 手順',
            '',
            '### 1. 入力情報の読み込み',
            '',
            `セッションディレクトリの \`${GRILL_NOTES_KEY}\` と \`${PREPARE_DECISION_KEY}\` を読み込む。`,
            'prepare-decision.json から mode / fromIssue / issueNumber / repo を確認する。',
            '',
            '### 2. ドキュメント要否の判断',
            '',
            `ADR-FORMAT.md（${join(mtGrillWithDocsDir, 'ADR-FORMAT.md')}）の作成 3 条件に照らし、ADR / CONTEXT を計画に残すか判断し、ユーザーに確認する。`,
            '',
            '残す場合:',
            `- ADR は ${join(mtGrillWithDocsDir, 'ADR-FORMAT.md')}、CONTEXT は ${join(mtGrillWithDocsDir, 'CONTEXT-FORMAT.md')} に従い内容を作成する`,
            '- ADR 連番は対象 repo の `docs/adr/` を確認して次番号を確定する',
            '- plan-format.md の `## 📄 ドキュメント` セクション形式（`### <リポジトリ相対パス>` + コードフェンス全文）で埋め込む',
            '',
            '### 3. 縦切り分解の検討（分解モードの場合）',
            '',
            '大きな計画を実行可能なミッションへ割る場合は、次を守る:',
            '- 各ミッションは 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする',
            '- 単独で確認できる振る舞いを持つ',
            '- 依存関係は実行順の Wave 配置で表現する（plan-format.md の `### 実行順` 参照）',
            '',
            '### 4. Issue body の確定',
            '',
            `plan-format.md（${join(mtPlanDir, 'plan-format.md')}）に従い、Issue body の最終本文を確定する。`,
            `確定した本文をセッションディレクトリに \`${ISSUE_BODY_KEY}\` として書き出す。`,
            '',
            '### 5. Draft Issue の作成または更新',
            '',
            `セッションディレクトリに issue-number.txt が存在する場合（リトライ時）は、既存 Issue を \`gh issue edit\` で更新する。`,
            '存在しない場合は新規作成する。',
            '',
            '#### 5a. from-Issue フロー（既存 Issue を更新）',
            '',
            '```bash',
            `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
            '```',
            '',
            '**重要:** 新規作成せず、必ず既存 Issue を更新すること。',
            '',
            '#### 5b. 新規作成フロー（mode: update）',
            '',
            '```bash',
            `gh issue create --title "<title>" --body-file ${ctx.sessionDir}/issue-body.md --label "kind/plan"`,
            '```',
            '',
            '#### 5c. 分解モード（mode: decompose）',
            '',
            '親 Issue を作成（または from-Issue の場合は更新）した後、各子計画について Issue を作成する（すべて `kind/plan` label + draft）:',
            '',
            '```bash',
            'gh issue create --title "<子タイトル>" --body-file <child-body-file> --label "kind/plan"',
            '```',
            '',
            '- 子計画は 1 階層までとし、再分解しない',
            '- 子の目的・対応スコープの和集合が親計画を過不足なく満たすこと',
            '- ドキュメントセクション（`## 📄 ドキュメント`）は対応する子計画の body に配置し、親には残さない',
            '',
            'GitHub REST API で親子関係を設定する:',
            '',
            '```bash',
            'gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \\',
            '  -f sub_issue_id=<child-issue-id>',
            '```',
            '',
            '### 6. Project への追加',
            '',
            'Issue（分解モードの場合は親子すべて）を GitHub Project に追加する（Status は `draft` に設定）:',
            '',
            '```bash',
            'gh project item-add <project-number> --owner <owner> --url <issue-url>',
            '```',
            '',
            '### 7. Issue 番号の記録',
            '',
            '作成・更新した Issue 番号（分解モードの場合は親番号）を issue-number.txt に記録する。',
            '',
            '## 成果物',
            '',
            'report 時の `artifacts` に以下を含める:',
            '```json',
            `{"key": "${ISSUE_BODY_KEY}", "path": "${join(ctx.sessionDir, ISSUE_BODY_KEY)}"}`,
            `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
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
    // Step 4: レビューゲート
    // -----------------------------------------------------------------
    {
      key: 'review_gate',
      phase: 'レビュー',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'abort' },
      humanGate: {
        presentArtifacts: ['issue-number.txt'],
        choices: [
          { value: 'approve', label: 'refined へ昇格する', desc: '内容が完成・実行可能。refined へ昇格して完了する' },
          { value: 'revise', label: '修正する', desc: 'Grill Phase に戻って内容を再検討する（Draft Issue は残し、更新する）' },
          { value: 'abort', label: '中断', desc: 'Draft Issue を残してセッションを終了する' },
        ],
        reviseTargetStep: 'grill',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -----------------------------------------------------------------
    // Step 5: 完了処理
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
