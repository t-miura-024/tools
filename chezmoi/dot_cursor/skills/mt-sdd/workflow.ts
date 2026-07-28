import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  AfterInitResult,
} from 'tado';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkSpecWriterOutput,
  checkSpecReviewOutput,
  checkProcessAudit,
  checkImplPlanOutput,
  checkPlanReviewOutput,
  checkCodeReviewOutput,
  checkValidationOutput,
} from './scripts/checks';

const SPEC_DIR = join(import.meta.dir, '..', 'mt-sdd-spec');
const IMPL_DIR = join(import.meta.dir, '..', 'mt-sdd-implement');
const VALIDATE_DIR = join(import.meta.dir, '..', 'mt-sdd-validate');

function templatePath(subskill: string, name: string): string {
  const base = subskill === 'spec' ? SPEC_DIR
    : subskill === 'implement' ? IMPL_DIR
    : VALIDATE_DIR;
  return join(base, 'templates', name);
}

// ---------------------------------------------------------------------------
// Shared prompt fragments (absorbed from subagent-protocol.md, review-framework.md, common-guidelines.md)
// ---------------------------------------------------------------------------

const REVIEW_FRAMEWORK = `## レビューコメントフォーマット
\`\`\`markdown
#### [連番] コメントタイトル
- **種別**: ❗ 指摘 / 💡 提案
- **重大度**: 🚨 Critical / ⚠️ Warning / ℹ️ Info
- **該当箇所**: 対象のセクション or タスク番号
- **上流変更要否**: No / Yes — 対象: spec.md / implementation-plan.md（変更内容の概要）
- **内容**: 具体的な指摘/提案内容
- **根拠**: なぜこれが問題か / なぜ改善になるか
- **推奨対応**: 具体的な修正案
\`\`\`

### 重大度判定基準
| 重大度 | 説明 | 判定基準 |
|--------|------|----------|
| 🚨 Critical | このまま進めると重大な問題が発生する仕様の根本的欠陥 | 自動修正ループ対象 |
| ⚠️ Warning | 推奨される修正（致命的ではない） | Human Gate で判断 |
| ℹ️ Info | 参考情報・ベタープラクティス | Human Gate で判断 |

### 総合判定基準
| 判定 | 条件 |
|------|------|
| **Pass** | Critical 指摘なし、Warning 3件以下 |
| **Conditional Pass** | Critical 指摘なし、Warning 4件以上 |
| **Fail** | Critical 指摘が1件以上存在 |`;

const UCR_PROTOCOL = `## UCR（上流変更要求）処理プロトコル

レビューコメントで「上流変更要否: Yes」がある場合、UCR として処理する。
再委譲による更新と評価は「上流から順に」行う（spec.md → implementation-plan.md → 残タスク）。

### 変更伝播マトリクス
| 検出フェーズ | spec.md | implementation-plan.md |
|---|---|---|
| 計画レビュー | Yes | —（対象成果物自体） |
| 実装 | Yes | Yes |
| コードレビュー | Yes | Yes |
| 仕様適合検証 | Yes | Yes |

### 処理順序
1. UCR を集約しユーザーに提示（全承認 / 個別選択 / 却下）
2. 承認された UCR について、対象成果物を担当 SubAgent に再委譲して更新
3. 上流成果物の更新後、下流成果物への連鎖影響を評価
4. 変更ログを \`appendix-change-log.md\` に記録
5. UCR 処理は Human Gate の**前**に実行する`;

const COMMON_GUIDELINES = `## SDD 共通ガイドライン
1. **SubAgent 委譲**: 各役割は \`Subagent\` ツールで委譲する
2. **UCR 処理**: 下流フェーズで上流成果物の変更が必要な場合、上記 UCR プロトコルに従う
3. **Critical 自動修正ループ**: Critical 指摘があれば、成果物作成 SubAgent に修正を指示 → 再レビュー。同一 Critical が 2 回続く場合はユーザーに判断を仰ぐ
4. **Warning/Info は Human Gate へ**: Critical 以外は人間が判断する
5. **プロセス遵守**: フェーズ/ステップをスキップしない。全中間生成物を生成する
6. **本文での選択肢提示**: ユーザーとの対話は番号付き選択肢や確認事項を本文で提示する`;

const SUBAGENT_PROTOCOL = `## SubAgent 実行プロトコル
1. 親エージェントはワークフロー全体、ユーザー対話、Human Gate、UCR 承認、成果物集約を担当
2. SubAgent は割り当てられた分析、作成、レビュー、実装、検証だけを担当
3. レビュー・監査・検証は \`readonly: true\`
4. 成果物作成・実装は \`readonly\` を付けない
5. SubAgent の結果は親エージェントが確認し、テンプレートに従って成果物へ集約する
6. 並列レビューは同一メッセージで複数の \`Subagent\` tool call を発行する`;

const SESSION_INFO = (ctx: PromptCtx) =>
  `## セッション情報
- セッションディレクトリ: ${ctx.sessionDir}
- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`;

function artifactPaths(ctx: PromptCtx) {
  const d = ctx.sessionDir;
  return {
    spec: join(d, 'spec.md'),
    hearingLog: join(d, 'appendix-hearing-log.md'),
    specReview: join(d, 'appendix-spec-review.md'),
    implPlan: join(d, 'implementation-plan.md'),
    planReview: join(d, 'appendix-plan-review.md'),
    codeReview: join(d, 'appendix-code-review.md'),
    validation: join(d, 'appendix-validation-report.md'),
    changeLog: join(d, 'appendix-change-log.md'),
  };
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

const def: WorkflowDef = {
  id: 'mt-sdd',

  beforeInit: async (ctx: InitCtx) => {
    const checks: string[] = [];

    if (!existsSync(SPEC_DIR)) checks.push(`mt-sdd-spec dir not found: ${SPEC_DIR}`);
    if (!existsSync(IMPL_DIR)) checks.push(`mt-sdd-implement dir not found: ${IMPL_DIR}`);
    if (!existsSync(VALIDATE_DIR)) checks.push(`mt-sdd-validate dir not found: ${VALIDATE_DIR}`);

    if (checks.length > 0) {
      throw new Error(`Prerequisites check failed:\n${checks.map((c) => `  - ${c}`).join('\n')}`);
    }
  },

  afterInit: async (ctx: InitCtx): Promise<AfterInitResult> => {
    const artifacts = [];
    return { artifacts };
  },

  steps: [
    // =======================================================================
    // Phase 1: 仕様策定 — コンテキスト収集
    // =======================================================================
    {
      key: 'phase1_context',
      phase: 'Phase 1a: コンテキスト収集',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            '仕様策定に必要なコンテキストを収集する。Codebase Explorer によるコードベース調査と、外部ソースの取得を行う。',
            '',
            '## 手順',
            '',
            '1. `explore` SubAgent を `readonly: true` で起動し、関連コードの構造・パターン・影響範囲を調査する',
            '   - ユーザーの要求概要を入力として渡す',
            '   - 既存の類似機能、命名規則、アーキテクチャパターンを重点的に調べさせる',
            '',
            '2. 外部ソース URL が提供されている場合、MCP（Notion/Figma/GitHub）優先で取得する',
            '   - 取得結果を要件情報として構造化し、曖昧な点は「不明」と明示する',
            '',
            '3. 収集結果を次のステップ（ヒアリング）で使えるように要約する',
            '',
            '## 出力',
            '',
            '収集結果をテキストで要約し、次ステップのヒアリングに備える。',
            SESSION_INFO(ctx),
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: ['context collection acknowledged'] }),
    },

    // =======================================================================
    // Phase 1: 仕様策定 — ヒアリング
    // =======================================================================
    {
      key: 'phase1_hearing',
      phase: 'Phase 1b: 要求ヒアリング',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: 'ヒアリング完了', desc: '要件が明確になり、仕様書作成に進める' },
          { value: 'abort', label: '中断', desc: 'ワークフローを中断する' },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // =======================================================================
    // Phase 1: 仕様策定 — Spec Writer
    // =======================================================================
    {
      key: 'phase1_spec_writer',
      phase: 'Phase 1c: 仕様書作成',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-sdd-spec-writer',
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          const specTemplate = templatePath('spec', 'spec.md');
          const hearingTemplate = templatePath('spec', 'appendix-hearing-log.md');
          return [
            '## 目的',
            '',
            '収集されたコンテキストとヒアリング結果をもとに、仕様書（spec.md）とヒアリング記録（appendix-hearing-log.md）を生成する。',
            '',
            '## 担当範囲',
            '',
            `- \`spec.md\` の作成（テンプレート \`${specTemplate}\` の構成に従う）`,
            `- \`appendix-hearing-log.md\` の作成（テンプレート \`${hearingTemplate}\` の構成に従う）`,
            '- 推測補完した仕様があれば hearing-log の「推測補完した仕様」セクションに明記する',
            '',
            '## 出力ファイル',
            '',
            `- ${p.spec}`,
            `- ${p.hearingLog}`,
            '',
            '## 注意',
            '',
            '- spec.md には 概要、背景・動機、用語定義、機能仕様（FS-*）、非機能要件、受け入れ基準、スコープ外 を含める',
            '- 各機能仕様にはテスト可能な受け入れ基準を付与する',
            '- 推測補完した箇所は明示的に記録する（後続の Human Gate でユーザーが確認する）',
            SESSION_INFO(ctx),
            SUBAGENT_PROTOCOL,
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkSpecWriterOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Phase 2: 仕様レビュー — 4観点並列
    // =======================================================================
    {
      key: 'phase2_spec_review',
      phase: 'Phase 2a: 仕様レビュー（4観点並列）',
      type: 'parallel',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      parallel: {
        subtasks: ([
          { key: 'completeness', type: 'mt-sdd-completeness-reviewer', desc: '網羅性: 要件カバレッジ、正常系・異常系・エッジケースの網羅、受け入れ基準の完備、前提条件・スコープ外の明示' },
          { key: 'feasibility', type: 'mt-sdd-feasibility-reviewer', desc: '実現可能性: 技術的実現性、パフォーマンス要件、外部依存の妥当性、データモデルの実現性' },
          { key: 'consistency', type: 'mt-sdd-consistency-reviewer', desc: '一貫性: アーキテクチャ整合、命名規則の統一、用語の一貫性、API設計の統一、類似機能との整合' },
          { key: 'risk', type: 'mt-sdd-risk-reviewer', desc: 'リスク: 認証・認可、入力検証、データ保護、パフォーマンスリスク、可用性リスク、ロールバック' },
        ] as const).map(({ key, type, desc }) => ({
          key,
          subagentType: type,
          readonly: true,
          buildPrompt: (ctx: PromptCtx) => {
            const p = artifactPaths(ctx);
            return [
              '## 目的',
              '',
              `「${desc.split(':')[0]}」観点で spec.md をレビューする。`,
              '',
              `## 観点説明`,
              '',
              desc,
              '',
              '## 入力',
              '',
              `- 仕様書: ${p.spec}`,
              `- ヒアリング記録: ${p.hearingLog}`,
              '',
              '## 出力要件',
              '',
              'レビューコメントを以下のフォーマットで出力する。ファイル書き込みは不要。',
              '',
              REVIEW_FRAMEWORK,
              '',
              '## 禁止事項',
              '',
              '- 担当観点以外の指摘を行わない',
              '- ファイルを直接編集しない',
              SESSION_INFO(ctx),
            ].join('\n');
          },
        })),
      },
      task: {
        action: 'run_subagent',
        buildPrompt: (_ctx: PromptCtx) => '',
      },
      check: (ctx: CheckCtx): CheckResult => checkSpecReviewOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Phase 2: Critical 修正ループ + Process Auditor
    // =======================================================================
    {
      key: 'phase2_spec_fix',
      phase: 'Phase 2b: 仕様修正ループ + 監査',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'goto', target: 'phase2_spec_review' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            '仕様レビューの Critical 指摘を修正し、修正版で再レビューする。自動修正ループが収束したら Process Auditor で監査する。',
            '',
            '## 手順',
            '',
            '1. レビュー結果から 🚨 Critical 指摘を抽出する',
            '',
            '2. Critical 指摘がある場合:',
            '   - `mt-sdd-spec-writer` に現在の `spec.md` と Critical 指摘を渡して修正を指示する',
            '   - 修正後、4観点レビュアーを再実行する',
            '   - 同一 Critical が 2 回続く場合はユーザーに判断を仰ぐ',
            '   - 修正後は `appendix-spec-review.md` を更新する',
            '',
            '3. Critical 指摘が解消されたら:',
            '   - `mt-sdd-process-auditor` SubAgent を `readonly: true` で起動する',
            '   - プロンプトには以下の監査観点を埋め込む:',
            '',
            '### 監査観点（process-auditor.md より）',
            '| 観点 | チェック項目 |',
            '|------|-------------|',
            '| 成果物の完全性 | 全セクション記述、空欄・TODO 残存なし、具体的な内容 |',
            '| レビューの反映度 | Critical 対応が本質的か、副作用がないか |',
            '| プロセス逸脱 | 手順スキップなし、成果物間の整合性あり |',
            '| UCR 処理の適切性 | 検出漏れなし、変更ログ記録あり |',
            '',
            '4. 監査結果を `appendix-spec-review.md` の末尾に「監査サマリ」として追記する',
            '',
            '```markdown',
            '## 監査サマリ',
            '',
            '- **プロセス健全性**: Healthy / Warning / Critical',
            '- **検出事項**: ...',
            '- **推奨アクション**: ...',
            '```',
            '',
            `### 成果物`,
            `- 仕様書: ${p.spec}`,
            `- レビューレポート: ${p.specReview}`,
            '',
            SESSION_INFO(ctx),
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkProcessAudit(ctx.sessionDir, ['spec.md', 'appendix-spec-review.md']),
    },

    // =======================================================================
    // Human Gate 1: 仕様確定
    // =======================================================================
    {
      key: 'phase2_human_gate',
      phase: 'Human Gate 1: 仕様確定',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: ['spec.md', 'appendix-spec-review.md'],
        choices: [
          { value: 'approve', label: '承認', desc: '仕様を確定し、実装計画フェーズへ進む' },
          { value: 'revise', label: '修正指示', desc: 'フィードバックをもとに仕様書を修正する（Phase 1c から再実行）' },
          { value: 'abort', label: '中止', desc: 'ワークフローを中断する' },
        ],
        reviseTargetStep: 'phase1_spec_writer',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // =======================================================================
    // Phase 4: 実装計画
    // =======================================================================
    {
      key: 'phase4_impl_planner',
      phase: 'Phase 4: 実装計画',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-sdd-implementation-planner',
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          const planTemplate = templatePath('implement', 'implementation-plan.md');
          return [
            '## 目的',
            '',
            '確定した仕様書をもとに、実装計画書（implementation-plan.md）を作成する。',
            '',
            '## 担当範囲',
            '',
            `- \`implementation-plan.md\` の作成（テンプレート \`${planTemplate}\` の構成に従う）`,
            '- タスクを Infrastructure / Backend / Frontend レイヤーに分類する',
            '- Backend タスクにはテストケースを定義する（TDD）',
            '- タスクの依存関係と実行順序を明示する',
            '- 変更ファイルのマッピングを作成する',
            '',
            '## 入力',
            '',
            `- 仕様書: ${p.spec}`,
            `- ヒアリング記録: ${p.hearingLog}`,
            '',
            '## 出力',
            '',
            `implementation-plan.md を ${p.implPlan} に書き出す。`,
            '',
            '## 注意',
            '',
            '- 仕様にない作業を含めない（スコープクリープ防止）',
            '- 各タスクは 1 ステップで完結可能な粒度にする',
            '- 実行順序は Infrastructure → Backend → Frontend を遵守する',
            '- コードベースの調査が必要な場合は自由に調査してよい',
            SESSION_INFO(ctx),
            SUBAGENT_PROTOCOL,
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkImplPlanOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Phase 5: 計画レビュー — 4観点並列
    // =======================================================================
    {
      key: 'phase5_plan_review',
      phase: 'Phase 5a: 計画レビュー（4観点並列）',
      type: 'parallel',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      parallel: {
        subtasks: ([
          { key: 'spec_alignment', type: 'mt-sdd-spec-alignment-reviewer', desc: '仕様適合: 機能カバレッジ、受け入れ基準カバレッジ、スコープクリープ、テストケースカバレッジ、仕様側の問題検出' },
          { key: 'architecture', type: 'mt-sdd-architecture-reviewer', desc: 'アーキテクチャ: ファイル構成、モジュール分割、技術選定、インターフェース設計、拡張性' },
          { key: 'task_structure', type: 'mt-sdd-task-structure-reviewer', desc: 'タスク構造: 粒度、レイヤー分類、順序、TDD適用、依存関係、デッドロック' },
          { key: 'risk_impact', type: 'mt-sdd-risk-impact-reviewer', desc: 'リスク・影響範囲: 影響範囲の把握、破壊的変更、高リスクタスク、テスト戦略、ロールバック戦略' },
        ] as const).map(({ key, type, desc }) => ({
          key,
          subagentType: type,
          readonly: true,
          buildPrompt: (ctx: PromptCtx) => {
            const p = artifactPaths(ctx);
            return [
              '## 目的',
              '',
              `「${desc.split(':')[0]}」観点で implementation-plan.md をレビューする。`,
              '',
              `## 観点説明`,
              '',
              desc,
              '',
              '## 入力',
              '',
              `- 実装計画書: ${p.implPlan}`,
              `- 仕様書: ${p.spec}`,
              '',
              '## 出力要件',
              '',
              'レビューコメントを以下のフォーマットで出力する。ファイル書き込みは不要。',
              '',
              REVIEW_FRAMEWORK,
              '',
              '## 禁止事項',
              '',
              '- 担当観点以外の指摘を行わない',
              '- ファイルを直接編集しない',
              SESSION_INFO(ctx),
            ].join('\n');
          },
        })),
      },
      task: {
        action: 'run_subagent',
        buildPrompt: (_ctx: PromptCtx) => '',
      },
      check: (ctx: CheckCtx): CheckResult => checkPlanReviewOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Phase 5: Critical 修正ループ + UCR + Process Auditor
    // =======================================================================
    {
      key: 'phase5_plan_fix',
      phase: 'Phase 5b: 計画修正ループ + UCR + 監査',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'goto', target: 'phase5_plan_review' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            '計画レビューの Critical 指摘と UCR（上流変更要求）を処理し、修正版で再レビューする。修正ループが収束したら Process Auditor で監査する。',
            '',
            '## 手順',
            '',
            '1. レビュー結果から UCR（上流変更要否: Yes）を抽出する',
            '',
            '2. UCR がある場合、Critical 修正ループより先に処理する:',
            UCR_PROTOCOL,
            '',
            '3. 🚨 Critical 指摘がある場合:',
            '   - `mt-sdd-implementation-planner` に現在の `implementation-plan.md` と Critical 指摘を渡して修正を指示する',
            '   - 修正後、4観点レビュアーを再実行する',
            '   - 同一 Critical が 2 回続く場合はユーザーに判断を仰ぐ',
            '   - 修正後は `appendix-plan-review.md` を更新する',
            '',
            '4. Critical 指摘が解消されたら:',
            '   - `mt-sdd-process-auditor` SubAgent を `readonly: true` で起動する',
            '   - プロンプトには監査観点（成果物の完全性 / 入力の反映度 / レビューの反映度 / プロセス逸脱 / UCR 処理の適切性）を埋め込む',
            '   - 監査結果を `appendix-plan-review.md` の末尾に「監査サマリ」として追記する',
            '',
            `### 成果物`,
            `- 実装計画書: ${p.implPlan}`,
            `- 仕様書: ${p.spec}`,
            `- レビューレポート: ${p.planReview}`,
            '',
            SESSION_INFO(ctx),
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult =>
        checkProcessAudit(ctx.sessionDir, ['implementation-plan.md', 'appendix-plan-review.md']),
    },

    // =======================================================================
    // Human Gate 2: 計画確定
    // =======================================================================
    {
      key: 'phase5_human_gate',
      phase: 'Human Gate 2: 計画確定',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: ['implementation-plan.md', 'appendix-plan-review.md'],
        choices: [
          { value: 'approve', label: '承認', desc: '計画を確定し、実装フェーズへ進む' },
          { value: 'revise', label: '修正指示', desc: 'フィードバックをもとに実装計画を修正する（Phase 4 から再実行）' },
          { value: 'abort', label: '中止', desc: 'ワークフローを中断する' },
        ],
        reviseTargetStep: 'phase4_impl_planner',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // =======================================================================
    // Phase 6: 実装（レイヤー順序）
    // =======================================================================
    {
      key: 'phase6_impl',
      phase: 'Phase 6: 実装',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            'implementation-plan.md のタスク一覧に従い、レイヤー順序で実装を実行する。',
            '',
            '## レイヤー実行順序',
            '',
            '```text',
            'Layer 1 (Infrastructure): DB マイグレーション、設定ファイル等',
            '  ↓',
            'Layer 2 (Backend - TDD): テスト作成 → Red → 実装 → Green',
            '  ↓',
            'Layer 3 (Frontend): UI コンポーネント、画面実装等',
            '```',
            '',
            '## 実行ルール',
            '',
            '1. レイヤー単位でタスクを整理し、Implementation Planner のレイヤー分類に従う',
            '2. 各タスクで `mt-sdd-implementer` SubAgent を起動する',
            '   - プロンプトには: 対象タスク定義、関連仕様セクション、完了済みレイヤータスクの要約、維持すべき制約を含める',
            '   - 仕様にないことは実装しない',
            '3. レイヤー内タスク継続時: 成果物ファイル、完了済みタスク要約、次タスク定義を prompt に含める',
            '4. レイヤーをまたぐ場合は新しい実行文脈として必要入力を明示する',
            '',
            '## UCR 検出・処理',
            '',
            'Implementer の出力に `[UCR]` プレフィックス付き報告があれば、UCR プロトコルに従って処理する。',
            'UCR 処理後、残りタスクへの影響を評価し、必要に応じて実行順序を調整する。',
            '',
            UCR_PROTOCOL,
            '',
            `## 入力`,
            `- 実装計画書: ${p.implPlan}`,
            `- 仕様書: ${p.spec}`,
            '',
            SESSION_INFO(ctx),
            SUBAGENT_PROTOCOL,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: ['implementation acknowledged'] }),
    },

    // =======================================================================
    // Phase 7: コードレビュー
    // =======================================================================
    {
      key: 'phase7_code_review',
      phase: 'Phase 7a: コードレビュー',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            '実装完了後のコード品質をレビューする。',
            '',
            '## 手順',
            '',
            '1. git diff を取得して実装差分を確認する',
            '   - mt-check-branch-diff Skill を使用、または `git diff` で直接取得',
            '',
            '2. `mt-sdd-code-reviewer` SubAgent を `readonly: true` で起動する',
            '   - プロンプトに git diff 全文を埋め込む',
            '   - レビューフォーマットとレビュー観点を埋め込む',
            '',
            '3. Code Reviewer の出力を確認し、`appendix-code-review.md` を生成する',
            '   - テンプレート: `appendix-code-review.md`',
            '',
            '## レビュー観点（mt-sdd-code-reviewer に渡す）',
            '',
            '- マクロ視点: アーキテクチャ整合性、責務分離、拡張性',
            '- ミクロ視点: コード品質、命名、エラーハンドリング、テスト品質',
            '',
            REVIEW_FRAMEWORK,
            '',
            `## 成果物`,
            `- コードレビューレポート: ${p.codeReview}`,
            `- 仕様書（参照）: ${p.spec}`,
            `- 実装計画書（参照）: ${p.implPlan}`,
            '',
            SESSION_INFO(ctx),
            SUBAGENT_PROTOCOL,
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkCodeReviewOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Phase 7: Critical 修正ループ + UCR
    // =======================================================================
    {
      key: 'phase7_code_fix',
      phase: 'Phase 7b: コード修正ループ + UCR',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'goto', target: 'phase7_code_review' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          return [
            '## 目的',
            '',
            'コードレビューの Critical 指摘と UCR を処理し、修正後に再レビューする。',
            '',
            '## 手順',
            '',
            '1. コードレビュー結果から UCR（上流変更要否: Yes）を抽出する',
            '',
            '2. UCR がある場合、Critical 修正ループより先に処理する:',
            UCR_PROTOCOL,
            '',
            '3. 🚨 Critical 指摘がある場合:',
            '   - `mt-sdd-implementer` に現在の差分、該当タスク、Critical 指摘を渡して修正を指示する',
            '   - 修正後、git diff を再取得してコードレビューを再実行する',
            '   - 同一 Critical が 2 回続く場合はユーザーに判断を仰ぐ',
            '   - 修正後は `appendix-code-review.md` を更新する',
            '',
            `## 成果物`,
            `- コードレビューレポート: ${p.codeReview}`,
            `- 仕様書: ${p.spec}`,
            `- 実装計画書: ${p.implPlan}`,
            '',
            SESSION_INFO(ctx),
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkCodeReviewOutput(ctx.sessionDir),
    },

    // =======================================================================
    // Human Gate 3: コードレビュー確定
    // =======================================================================
    {
      key: 'phase7_human_gate',
      phase: 'Human Gate 3: コードレビュー確定',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: ['appendix-code-review.md'],
        choices: [
          { value: 'approve', label: '承認', desc: 'コードレビューを確定し、仕様適合検証フェーズへ進む' },
          { value: 'revise', label: '修正指示', desc: 'フィードバックをもとにコードを修正する（Phase 6 から再実行）' },
          { value: 'abort', label: '中止', desc: 'ワークフローを中断する' },
        ],
        reviseTargetStep: 'phase6_impl',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    // =======================================================================
    // Phase 8: 仕様適合検証
    // =======================================================================
    {
      key: 'phase8_validate',
      phase: 'Phase 8: 仕様適合検証',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const p = artifactPaths(ctx);
          const validateTemplate = templatePath('validate', 'appendix-validation-report.md');
          return [
            '## 目的',
            '',
            '実装が仕様の受け入れ基準に適合しているかを機械的に検証し、検証レポートを生成する。',
            '',
            '## 手順',
            '',
            '1. git diff を取得して実装差分を確認する',
            '   - mt-check-branch-diff Skill を使用、または `git diff` で直接取得',
            '',
            '2. `mt-sdd-validator` SubAgent を `readonly: true` で起動する',
            '   - プロンプトに git diff 全文を埋め込む',
            `   - テンプレート: ${validateTemplate}`,
            `   - 仕様書の受け入れ基準セクションを読ませる: ${p.spec}`,
            '   - 検証結果をテキストで出力させる（ファイル書き込みは不要）',
            '',
            '3. Validator の出力を確認し、`appendix-validation-report.md` を生成する',
            '',
            '4. UCR 集約:',
            '   - 検証結果の `[UCR]` プレフィックス付き報告を抽出する',
            '   - 受け入れ基準の不備 → spec.md への UCR',
            '   - 仕様と技術的現実の乖離 → spec.md への UCR',
            '   - 計画と実装の不一致 → implementation-plan.md への UCR',
            '',
            '5. 不適合項目がある場合は修正方針をユーザーに提示する',
            '',
            UCR_PROTOCOL,
            '',
            `## 成果物`,
            `- 検証レポート: ${p.validation}`,
            `- 仕様書（参照）: ${p.spec}`,
            '',
            SESSION_INFO(ctx),
            SUBAGENT_PROTOCOL,
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => checkValidationOutput(ctx.sessionDir),
    },
  ],
};

export default def;
