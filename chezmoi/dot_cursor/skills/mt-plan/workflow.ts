import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ArtifactRecord,
} from '../mt-workflow/types';
import { join } from 'node:path';
import { loadConfig } from './init-config';

interface ReviewResult {
  round: number;
  axes: Record<string, Array<{ severity: string; detail: string }>>;
  counts: { must: number; should: number; want: number };
}

function validateReviewJson(raw: string | undefined): { valid: boolean; mustCount: number; error?: string } {
  if (!raw) return { valid: false, mustCount: -1, error: 'agent-review.json not found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, mustCount: -1, error: 'agent-review.json is not valid JSON' };
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.round !== 'number') return { valid: false, mustCount: -1, error: 'missing or invalid round' };
  if (typeof r.axes !== 'object' || r.axes === null) return { valid: false, mustCount: -1, error: 'missing axes' };
  const expectedAxes = ['essentiality', 'acceptance', 'scope', 'alignment', 'quality'];
  for (const k of expectedAxes) {
    if (!(k in r.axes)) return { valid: false, mustCount: -1, error: `missing axis: ${k}` };
    if (!Array.isArray((r.axes as Record<string, unknown>)[k])) return { valid: false, mustCount: -1, error: `axis ${k} is not an array` };
  }
  if (typeof r.counts !== 'object' || r.counts === null) return { valid: false, mustCount: -1, error: 'missing counts' };
  const c = r.counts as Record<string, unknown>;
  if (typeof c.must !== 'number') return { valid: false, mustCount: -1, error: 'missing must count' };

  let totalMust = 0;
  for (const k of expectedAxes) {
    const items = (r.axes as Record<string, unknown>)[k] as Array<Record<string, unknown>>;
    for (const item of items) {
      if (item.severity === 'must') totalMust++;
    }
  }
  if (totalMust !== c.must) return { valid: false, mustCount: c.must, error: `must count mismatch: counts.must=${c.must}, actual=${totalMust}` };

  return { valid: true, mustCount: c.must };
}

function findReviewRound(
  attempts: Array<{ attemptNumber: number; endedAt?: string; checkStatus?: string }>,
): number {
  let maxRound = 0;
  for (const a of attempts) {
    // Previous review_work attempts that passed or failed indicate a round
    if (a.checkStatus === 'pass' || a.checkStatus === 'fail') {
      maxRound = Math.max(maxRound, a.attemptNumber);
    }
  }
  return maxRound;
}

function findArtifactText(artifacts: ArtifactRecord[], key: string): string | undefined {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) return undefined;
  const fs = require('node:fs');
  try {
    return fs.readFileSync(match.filePath, 'utf-8') as string;
  } catch {
    return undefined;
  }
}

const REVIEW_JSON_KEY = 'agent-review.json';

const def: WorkflowDef = {
  id: 'mt-plan',

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
      key: 'identify_plan',
      phase: '計画の特定',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'abort' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: '計画を特定した', desc: 'Issue番号を確認し次へ進む' },
          { value: 'abort', label: '中断' },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 2: 実行開始（refined → in-progress）
    // -------------------------------------------------------------------
    {
      key: 'start_execution',
      phase: '実行開始',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。',
            '',
            '## 手順',
            '',
            '1. ユーザーが指定した計画 Issue 番号 `<number>` を確認する（初回ヒアリングで取得済み）',
            '',
            '2. Issue の存在・状態を検証する:',
            '',
            '```bash',
            'gh issue view <number> --json state,labels,number,title,url',
            '```',
            '',
            '- `kind/plan` label が付与されていることを確認',
            '- `state` が `OPEN` であることを確認',
            '',
            '3. `list-plans.ts` で status を確認し、`refined` または `in-progress` であることを検証する:',
            '',
            '```bash',
            `bun run ${join(import.meta.dir, 'list-plans.ts')}`,
            '```',
            '',
            '- `draft` なら `mt-create-plan` へ案内して中断',
            '- `done` なら「完了済み。再開しますか？」と確認',
            '',
            '4. GitHub Sub Issue を確認する。Sub Issue を持つ親計画は実行できないため、子計画を選び直して中断する:',
            '',
            '```bash',
            'gh api repos/<owner>/<repo>/issues/<number>/sub_issues',
            '```',
            '',
            '5. `transition-plan.ts` を使って `refined` → `in-progress` に遷移する:',
            '',
            '```bash',
            `bun run ${join(import.meta.dir, 'transition-plan.ts')} <number> in-progress`,
            '```',
            '',
            '既に `in-progress` の場合はスキップする。',
            '',
            '6. Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:',
            '',
            '```bash',
            'gh issue view <number> --json body',
            '```',
            '',
            '7. 読み込んだ内容の要点を報告する:',
            '   - 完了条件の数と概要',
            '   - 主要な方針',
            '   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）',
            '',
            '8. 計画番号を workflow.db に保存する: report 時の `artifacts` フィールドに以下を含めること:',
            '```json',
            '{"key": "plan_number", "path": "<number>"}',
            '```',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 3: 作業実行（executor SubAgent 委譲・並列）
    // -------------------------------------------------------------------
    {
      key: 'execute_work',
      phase: '作業実行',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '計画 Issue の `## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針` に従って作業を実行する。',
            '作業の実施は必ず `mt-plan-work-executor` SubAgent に委譲する。オーケストレーター自身はファイル編集を行わず、ユニットの割り振り・進行管理・Issue body 更新に専念する。',
            '',
            '## 修正ソース（再実行時に適用）',
            '',
            'execute_work に戻ってきた場合、以下の 3 ソースから修正指示を統合して executor SubAgent に渡す:',
            '',
            '1. **agent-review.json の must 指摘**（review_work の SubAgent レビューで検出された必須修正）',
            '2. **agent-review.json の should / want 指摘**（review_followups_gate で人間が「対応する」を選んだ場合）',
            '3. **human-feedback.json の items**（confirm_done または review_followups_gate で人間が revise を選んだ場合の指摘）',
            '',
            '各ソースの存在確認:',
            '- セッションディレクトリの `agent-review.json` を読み、must（および should/want 対応時はそれらも含む）指摘を抽出する',
            '- セッションディレクトリの `human-feedback.json` を読み、`items` 配列の指摘を抽出する',
            '- 存在しないファイルは無視する（初回実行時は両方なし）',
            '',
            '修正指示の仕分け:',
            '- 指摘を該当ユニットのスコープで仕分けし、担当の executor SubAgent に修正指示として渡す',
            '- 3 ソースの指摘は優先度なく統一的に扱う（すべて対応対象）',
            '',
            '## 手順',
            '',
            '### 1. 実行単位の読み取り',
            '',
            'Issue body（`gh issue view <number> --json body`）から `## 🧩 実行単位` セクションを読み取る:',
            '',
            '- セクションがある場合: 各 `### U<n>: <名前>` ユニットのスコープ・完了条件・依存関係を把握する',
            '- セクションがない場合: 計画全体を 1 ユニット（`U1: 全体`、スコープは計画のアウトプット範囲、完了条件は全番号、依存なし）として扱う',
            '',
            '### 2. executor SubAgent の起動',
            '',
            '依存関係を解決しながら、Task ツールで `subagent_type = "mt-plan-work-executor"` を起動する:',
            '',
            '- `依存: なし` のユニット同士は並列起動する（最大 5 同時）。同一メッセージで複数の Task ツール呼び出しを行う',
            '- 依存があるユニットは、先行ユニットの完了報告を受けてから起動する',
            '- 各 SubAgent に渡す情報:',
            '  - 計画 Issue body 全文（完了条件・方針・アウトプットの判断に必要）',
            '  - 担当ユニット定義（ID・名前・スコープ・完了条件番号・依存）',
            '  - 修正指示（再実行時のみ: agent-review.json の該当指摘 + human-feedback.json の items）',
            '',
            '### 3. 完了報告の集約',
            '',
            '- 全ユニットの完了報告（変更ファイル一覧・検証結果・未解決事項）を集約する',
            '- ユニットがスコープ外変更の必要を報告した場合は、作業を止めてユーザーに計画修正を提案する',
            '- いずれかのユニットが失敗した場合は report を `status: "failed"` とし、失敗内容を errors に含める',
            '',
            '## Issue body 更新（オーケストレーターが実施）',
            '',
            '以下のタイミングで更新する:',
            '- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行済み）',
            '- 全ユニット完了後: `## 🐢 履歴` へユニットごとの変更内容と確認結果を追記',
            '- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記',
            '- 中断時: `## 🐢 履歴` または `## 🐿️ メモ` へ完了済みユニット・次回再開位置・残論点を残す',
            '',
            '更新前は必ず `gh issue view` で body を読み、他者の差分を上書きしない。',
            '',
            '`## 🐿️ メモ` の運用:',
            '- `💭 背景:` … 前提・制約',
            '- `🤔 論点:` … 未決事項・要確認事項',
            '- `🧭 指針:` … 合意済み判断・運用ルール',
            '- 未解決の論点は Done 前に解消・方針へ取り込み・スコープ外化のいずれかを行う',
            '',
            '```bash',
            'gh issue edit <number> --repo <repo> --body-file <tmpfile>',
            '```',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- 試行: ${ctx.attemptNumber}/${ctx.maxRetries}`,
            '',
            '## 禁止事項',
            '',
            '- オーケストレーター自身がファイルを編集しない（作業は必ず executor SubAgent へ委譲）',
            '- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する',
            '- ユーザー承認前に `done` 化しない',
            '- 全ユニットの完了前に次のステップへ進まない',
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 4: レビュー（SubAgent による客観レビュー）
    // -------------------------------------------------------------------
    {
      key: 'review_work',
      phase: 'レビュー',
      type: 'task',
      maxRetries: 0,
      onFail: { action: 'goto', target: 'execute_work', requeueSource: true },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-plan-work-reviewer',
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const collectScriptPath = join(import.meta.dir, 'collect-review-context.ts');
          const jsonPath = join(ctx.sessionDir, 'agent-review.json');
          const mdPath = join(ctx.sessionDir, 'agent-review.md');
          const prevRound = findReviewRound(ctx.previousAttempts);
          const nextRound = prevRound + 1;

          return [
            '## 目的',
            '',
            '専用のレビュアー SubAgent に委譲し、5 観点で客観レビューを行う。',
            '',
            '## 手順',
            '',
            '### 1. 証拠収集（スクリプト実行）',
            '',
            '```bash',
            `bun run ${collectScriptPath} --plan-number <plan_number> --session-dir ${ctx.sessionDir}`,
            '```',
            '',
            '<plan_number> は workflow.db に保存した plan_number を使用する。',
            '',
            '### 2. SubAgent 委譲',
            '',
            `Task ツールで subagent_type = "mt-plan-work-reviewer" を指定し、以下を指示する:`,
            '',
            '- セッションディレクトリから `issue-body.md`、`git-branch-diff.txt`、`git-unstaged-diff.txt` を読み込む',
            '- 5 観点でレビューし、agent-review.json スキーマの JSON を返す',
            `- round 番号は ${nextRound} で、前回レビューからの差分に注目する（初回は全量レビュー）`,
            '',
            '### 3. 結果の保存',
            '',
            `SubAgent から返却された JSON を ${jsonPath} に書き出す。`,
            `必要に応じて人間可読版を ${mdPath} に書き出す。`,
            '',
            '### 4. report',
            '',
            'artifacts に以下を含めて report する:',
            '```json',
            `{"key": "agent-review.json", "path": "${jsonPath}"}`,
            '```',
            '',
            '## レビュー観点（SubAgent に委譲）',
            '',
            '1. **本質性・効率性 (essentiality):** 目的に対して本質的で効率的な解決となっているか',
            '2. **完了条件の充足 (acceptance):** `## ✅ 完了条件` は完全に満たせているか',
            '3. **スコープの遵守 (scope):** スコープ外の対応はしていないか',
            '4. **方針との整合 (alignment):** `## 🧭 方針` から大きく外れた対応はしていないか',
            '5. **アウトプットの品質 (quality):** `## 📦 アウトプット` の品質は問題ないか',
            '',
            '## 出力スキーマ',
            '',
            '```json',
            '{',
            `  "round": ${nextRound},`,
            '  "axes": {',
            '    "essentiality": [{"severity": "must|should|want", "detail": "..."}],',
            '    "acceptance": [...],',
            '    "scope": [...],',
            '    "alignment": [...],',
            '    "quality": [...]',
            '  },',
            '  "counts": {"must": <N>, "should": <N>, "want": <N>}',
            '}',
            '```',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        const raw = findArtifactText(ctx.artifacts, REVIEW_JSON_KEY);
        const result = validateReviewJson(raw);
        if (!result.valid) {
          return { status: 'error', reasons: [result.error ?? 'validation failed'] };
        }
        if (result.mustCount > 0) {
          return { status: 'fail', reasons: [`must: ${result.mustCount} items`] };
        }
        return { status: 'pass', reasons: ['must: 0'] };
      },
    },

    // -------------------------------------------------------------------
    // Step 5: should/want 確認
    // -------------------------------------------------------------------
    {
      key: 'review_followups_gate',
      phase: 'should/want 確認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [REVIEW_JSON_KEY],
        choices: [
          { value: 'approve', label: '対応不要で進む', desc: 'should/want は対応不要と判断。Done 確認へ' },
          { value: 'revise', label: '対応する', desc: 'should/want に対応するため execute_work に戻る' },
          { value: 'abort', label: '中断' },
        ],
        reviseTargetStep: 'execute_work',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 6: Done 確認
    // -------------------------------------------------------------------
    {
      key: 'confirm_done',
      phase: 'Done 確認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: 'Done にする', desc: '計画を完了としてマークする' },
          { value: 'revise', label: '修正する', desc: '成果物に問題がある。execute_work に戻って修正する' },
          { value: 'abort', label: '中断' },
        ],
        reviseTargetStep: 'execute_work',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 7: 完了処理（in-progress → done）
    // -------------------------------------------------------------------
    {
      key: 'finalize_done',
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
            '計画 Issue を `done` に遷移し、完了処理を行う。',
            '',
            '## 手順',
            '',
            '1. Issue body を再読み込みし、完了条件がすべて満たされていることを最終確認する',
            '',
            '2. `transition-plan.ts` を使って `in-progress` → `done` に遷移する:',
            '',
            '```bash',
            `bun run ${join(import.meta.dir, 'transition-plan.ts')} <number> done`,
            '```',
            '',
            'このコマンドは以下を自動実行する:',
            '- GitHub Project の Status を `done` に更新',
            '- Issue を close',
            '- `## 🐢 履歴` へ遷移エントリを追記',
            '- 親計画が存在する場合は自動的に親の状態集約を行う（出力の `parent:` 行を確認）',
            '',
            '3. 完了を報告する:',
            '   - Issue の URL・番号',
            '   - 完了した作業',
            '   - 残っている未決事項（あれば）',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },
  ],
};

export default def;
