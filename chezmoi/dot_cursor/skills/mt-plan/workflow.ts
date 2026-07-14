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
  if (!raw) return { valid: false, mustCount: -1, error: 'review-current.json not found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, mustCount: -1, error: 'review-current.json is not valid JSON' };
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

const REVIEW_JSON_KEY = 'review-current.json';

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
            '4. `transition-plan.ts` を使って `refined` → `in-progress` に遷移する:',
            '',
            '```bash',
            `bun run ${join(import.meta.dir, 'transition-plan.ts')} <number> in-progress`,
            '```',
            '',
            '既に `in-progress` の場合はスキップする。',
            '',
            '5. Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:',
            '',
            '```bash',
            'gh issue view <number> --json body',
            '```',
            '',
            '6. 読み込んだ内容の要点を報告する:',
            '   - 完了条件の数と概要',
            '   - 主要な方針',
            '   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）',
            '',
            '7. 計画番号を workflow.db に保存する: report 時の `artifacts` フィールドに以下を含めること:',
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
    // Step 3: 作業実行
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
            '',
            'review_work から戻ってきた場合は、review-current.json の `must` 指摘だけを修正する。',
            'should / want はこのステップでは対応しない。',
            '',
            '## 進め方',
            '',
            '- 方針は判断基準として扱い、進捗チェックリスト化しない',
            '- 完了判断は方針の消化ではなく `## ✅ 完了条件` の充足で行う',
            '- スコープを超える作業が必要なら、勝手に範囲を広げずユーザーに確認する',
            '- 直接実行モード（ファイル編集・コード変更・ローカル検証）とガイドモード（外部操作・ユーザー判断）を適切に切り替える',
            '',
            '## Issue body 更新',
            '',
            '以下のタイミングで更新する:',
            '- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行済み）',
            '- 実行結果の確認後: `## 🐢 履歴` へ変更内容と確認結果を追記',
            '- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記',
            '- 中断時: `## 🐢 履歴` または `## 🐿️ メモ` へ次回再開位置と残論点を残す',
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
            '- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する',
            '- ユーザー承認前に `done` 化しない',
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 4: レビュー（task: 5軸レビュー + must=0 判定）
    // -------------------------------------------------------------------
    {
      key: 'review_work',
      phase: 'レビュー',
      type: 'task',
      maxRetries: 0,
      onFail: { action: 'goto', target: 'execute_work', requeueSource: true },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '完了した作業を 5 観点でレビューし、結果を review-current.json と review-current.md に出力する。',
            '',
            '## レビュー観点',
            '',
            '1. **本質性・効率性 (essentiality):** 目的に対して本質的で効率的な解決となっているか',
            '2. **完了条件の充足 (acceptance):** `## ✅ 完了条件` は完全に満たせているか',
            '3. **スコープの遵守 (scope):** スコープ外の対応はしていないか',
            '4. **方針との整合 (alignment):** `## 🧭 方針` から大きく外れた対応はしていないか',
            '5. **アウトプットの品質 (quality):** `## 📦 アウトプット` の品質は問題ないか',
            '',
            '## 指摘の深刻度',
            '',
            '- **must:** 必ず修正しなければならない重大な問題',
            '- **should:** 必須ではないが修正すべき問題',
            '- **want:** 任意の改善提案',
            '',
            '## 出力',
            '',
            '1. `review-current.json` を作成し、report 時の artifacts に含める:',
            '',
            '```json',
            '{',
            '  "round": <前回+1>,',
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
            '',
            '2. `review-current.md` を人間可読形式で作成する。',
            '',
            '## ルール',
            '',
            '- 5 観点すべてを必ず評価する（指摘がない観点は空配列）',
            '- `counts.must` は axes 内の must 件数と一致させる',
            '- must > 0 の場合は reason に「must: N items」を含めて report する',
            '- must = 0 の場合のみ reason に「must: 0」として report する',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
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
          { value: 'abort', label: '中断' },
        ],
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
