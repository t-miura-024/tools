import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  AfterInitResult,
} from '../mt-workflow/types';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  auditPlanner,
  auditResearcher,
  auditWriter,
  auditReviewer,
  auditResearchCycle,
  auditWriterReviewerCycle,
} from './scripts/audit';
import type { AuditCheck } from './scripts/audit';

const SCRIPTS_DIR = join(import.meta.dir, 'scripts');

function openResearchDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function toCheckResult(checks: AuditCheck[]): CheckResult {
  const errored = checks.filter((c) => c.status === 'error');
  if (errored.length > 0) {
    return { status: 'error', reasons: errored.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length > 0) {
    return { status: 'fail', reasons: failed.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  return { status: 'pass', reasons: checks.map((c) => `${c.check_name}: ${c.detail}`) };
}

const RESEARCH_DB = 'research.db';

const def: WorkflowDef = {
  id: 'mt-deep-research',

  beforeInit: async (ctx: InitCtx) => {
    const checks: string[] = [];

    try {
      const searx = await $`curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"`.nothrow().quiet();
      if (searx.stdout.toString().trim() !== '200') {
        checks.push('SearXNG is not responding (http://localhost:8080)');
      }
    } catch {
      checks.push('SearXNG check failed');
    }

    try {
      await $`command -v jq`.nothrow().quiet();
    } catch {
      checks.push('jq is not installed');
    }

    try {
      await $`command -v pandoc`.nothrow().quiet();
    } catch {
      checks.push('pandoc is not installed');
    }

    try {
      await $`command -v bun`.nothrow().quiet();
    } catch {
      checks.push('bun is not installed');
    }

    if (!existsSync(join(SCRIPTS_DIR, 'node_modules'))) {
      const install = await $`cd ${SCRIPTS_DIR} && bun install`.nothrow().quiet();
      if (install.exitCode !== 0) {
        checks.push(`bun install failed in ${SCRIPTS_DIR}`);
      }
    }

    if (checks.length > 0) {
      throw new Error(`Prerequisites check failed:\n${checks.map((c) => `  - ${c}`).join('\n')}`);
    }
  },

  afterInit: async (ctx: InitCtx): Promise<AfterInitResult> => {
    const dbPath = join(ctx.sessionDir, RESEARCH_DB);
    const result = await $`bun run ${join(SCRIPTS_DIR, 'db.ts')} init --db-path ${dbPath}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      throw new Error(`DB init failed: ${result.stderr.toString()}`);
    }
    return { artifactDbPath: dbPath };
  },

  steps: [
    // -----------------------------------------------------------------------
    // Phase 3: 計画立案 (Planner)
    // -----------------------------------------------------------------------
    {
      key: 'phase3_planner',
      phase: 'Phase 3: 計画立案',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-deep-research-planner',
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const planPath = join(ctx.sessionDir, 'plan.md');
          const planTemplate = join(import.meta.dir, 'templates', 'plan.md');
          return [
            '## 目的',
            '',
            'plan.md を作成し、questions テーブルに 3〜7 個（推奨 5 個）の主要な問いを登録してください。',
            '',
            '## 担当範囲',
            '',
            '- plan.md の作成（`templates/plan.md` の構成に従う、mermaid 必須）',
            '- questions テーブルへの問い登録（`db.ts question create` を使用）',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath ?? '(none)'}`,
            `- plan.md 出力先: ${planPath}`,
            `- plan テンプレート: ${planTemplate}`,
            '',
            '## 実行コマンド',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'db.ts')} question create --content "..." --order 1 --db-path ${ctx.artifactDbPath}`,
            '```',
            '',
            '## 禁止事項',
            '',
            '- ファイルを直接編集しない（plan.md は書き込み可）',
            '- Human Gate を代行しない',
            '- 制約・スコープも Planner が提案する',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const planPath = join(ctx.sessionDir, 'plan.md');
          const checks = auditPlanner(db, planPath);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 4: 調査 (Researcher, orchestrate)
    // -----------------------------------------------------------------------
    {
      key: 'phase4_researcher',
      phase: 'Phase 4: 調査',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            '承認されたすべての問いについて、Researcher SubAgent を並列起動し、調査を実行する。',
            '',
            '## 手順',
            '',
            '1. research.db から approved 状態の questions を取得する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'db.ts')} question list --status approved --db-path ${ctx.artifactDbPath}`,
            '```',
            '',
            '2. 各 question_id に対して `mt-deep-research-researcher` SubAgent を並列起動する（最大 5 同時）',
            '   - 各 SubAgent には question_id、round_number、db.ts snapshot の出力を渡す',
            '   - 期待する成果物: evidence_rounds / sources / facts / off_topic_questions の一括保存',
            '   - 保存は SubAgent が `db.ts evidence save --data \'...\'` で行う',
            '   - 各 Researcher のループは最大 5 ラウンド',
            '   - 担当する question_id 以外の調査結果を参照しない',
            '',
            '3. 各 Researcher 完了後、機械監査を実行する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'audit.ts')} phase --phase researcher --db-path ${ctx.artifactDbPath} --question-id <ID>`,
            '```',
            '',
            '4. 監査 NG の場合は該当 Researcher にフィードバック（最大 3 回まで再委譲）',
            '5. 3 回を超えても NG の場合は人間に「範囲を狭める」「このまま進める」「中断する」を提示',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
            `- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`,
            '',
            '## 禁止事項',
            '',
            '- 全問いの調査が完了する前に次のフェーズに進まない',
            '- SubAgent に他の問いの調査結果を混入させない',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const checks = auditResearcher(db);

          const approved = db.query(
            "SELECT id FROM questions WHERE status = 'approved'",
          ).all() as { id: number }[];

          if (approved.length === 0) {
            checks.push({ check_name: 'approved_questions_exist', status: 'fail', detail: 'no approved questions' });
          } else {
            const uncovered: number[] = [];
            for (const q of approved) {
              const c = (db.query(
                'SELECT COUNT(*) AS c FROM evidence_rounds WHERE question_id = ?',
              ).get(q.id) as { c: number })?.c ?? 0;
              if (c === 0) uncovered.push(q.id);
            }
            checks.push({
              check_name: 'all_approved_questions_have_rounds',
              status: uncovered.length === 0 ? 'pass' : 'fail',
              detail: uncovered.length === 0
                ? `all ${approved.length} approved questions have rounds`
                : `questions without rounds: ${uncovered.join(', ')}`,
            });
          }

          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 5: research サイクル監査
    // -----------------------------------------------------------------------
    {
      key: 'phase5_research_cycle_audit',
      phase: 'Phase 5: research サイクル監査',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 目的',
            '',
            'research サイクル全体の機械監査を実行し、問題があれば Auditor に意味整合性評価を依頼する。',
            '',
            '## 手順',
            '',
            '1. 機械監査を実行する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'audit.ts')} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
            '```',
            '',
            '2. 監査が pass なら完了',
            '3. 監査が fail/error の場合:',
            '   - `mt-deep-research-auditor` SubAgent を呼び出して意味的整合性を評価',
            '   - Auditor には `db.ts snapshot --cycle research` の出力を渡す',
            '   - Auditor の出力 JSON は `db.ts audit save` で research.db に保存',
            '   - 必要に応じて Researcher に追加調査を依頼',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
            `- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`,
            '',
            '## 監査コマンド',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'audit.ts')} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
            '```',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const checks = auditResearchCycle(db);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 6: チェックポイント (Human Gate)
    // -----------------------------------------------------------------------
    {
      key: 'phase6_checkpoint',
      phase: 'Phase 6: チェックポイント',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: '次へ進む', desc: 'off_topic_questions の処理完了' },
          { value: 'abort', label: '中断' },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => {
        return { status: 'pass', reasons: [] };
      },
    },

    // -----------------------------------------------------------------------
    // Phase 7: レポート作成 (Writer)
    // -----------------------------------------------------------------------
    {
      key: 'phase7_writer',
      phase: 'Phase 7: レポート作成',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-deep-research-writer',
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, 'report.md');
          const reportTemplate = join(import.meta.dir, 'templates', 'report.md');
          return [
            '## 目的',
            '',
            '収集された調査結果をもとに report.md を作成・更新する。',
            '',
            '## 入力',
            '',
            '`db.ts snapshot --cycle writer-reviewer` の出力を使用する。',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'db.ts')} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
            '```',
            '',
            '## 担当範囲',
            '',
            `- report.md の作成・更新（\`${reportTemplate}\` の構成に従う、mermaid 必須）`,
            '- 番号引用 `[N]` は sources.source_number と一致させる',
            '- 情報源は `## 情報源の一覧` に含める',
            '',
            '## 出力',
            '',
            `report.md を ${reportPath} に書き出す。`,
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
            `- report.md 出力先: ${reportPath}`,
            `- report テンプレート: ${reportTemplate}`,
            `- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`,
            '',
            '## 禁止事項',
            '',
            '- ファイルを直接編集しない（report.md は書き込み可）',
            '- 未解決の問い・次のアクション・中間まとめを含めない',
            '- SearXNG 信頼性注意書きを含めない',
            '- レポートの全文をセッションに出力しない（完了報告は簡潔に）',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, 'report.md');
          const checks = auditWriter(db, reportPath);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 8: レビュー (Reviewer, parallel)
    // -----------------------------------------------------------------------
    {
      key: 'phase8_reviewer',
      phase: 'Phase 8: レビュー',
      type: 'parallel',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      parallel: {
        subtasks: (['coverage', 'sources', 'accuracy', 'structure', 'citations'] as const).map((aspect) => ({
          key: `reviewer_${aspect}`,
          subagentType: 'mt-deep-research-reviewer',
          readonly: true,
          buildPrompt: (ctx: PromptCtx) => {
            const reportPath = join(ctx.sessionDir, 'report.md');
            const aspectDesc: Record<string, string> = {
              coverage: '調査範囲の網羅性：すべての問いがレポートでカバーされているか',
              sources: '情報源の品質：引用が適切で信頼性の高いソースが使われているか',
              accuracy: '事実の正確性：evidence とレポートの記述が一致しているか',
              structure: '構造の妥当性：必須セクションが揃い、論理的な流れになっているか',
              citations: '引用の整合性：番号引用 [N] が sources.source_number と一致しているか',
            };
            return [
              '## 目的',
              '',
              `「${aspect}」観点で report.md をレビューする。`,
              '',
              `## 観点説明: ${aspect}`,
              '',
              aspectDesc[aspect] ?? '',
              '',
              '## 入力',
              '',
              '以下のスナップショットから report.md と research.db の内容を取得する:',
              '',
              '```bash',
              `bun run ${join(SCRIPTS_DIR, 'db.ts')} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
              '```',
              '',
              '## 出力',
              '',
              '`db.ts review save` で JSON を保存する。findings は以下のカテゴリで分類する:',
              '- `must_fix`: 修正が必須の問題',
              '- `research_needed`: 追加調査が必要な項目（`target_question_id` を必ず付与）',
              '- `suggestions`: 任意の改善提案',
              '',
              '```bash',
              `bun run ${join(SCRIPTS_DIR, 'db.ts')} review save --db-path ${ctx.artifactDbPath} --data '{ ... }'`,
              '```',
              '',
              '## セッション情報',
              '',
              `- セッションディレクトリ: ${ctx.sessionDir}`,
              `- research.db: ${ctx.artifactDbPath}`,
              `- report.md: ${reportPath}`,
              '',
              '## 禁止事項',
              '',
              '- 担当観点以外の指摘を行わない',
              '- ファイルを直接編集しない',
            ].join('\n');
          },
        })),
      },
      task: {
        action: 'run_subagent',
        buildPrompt: (_ctx: PromptCtx) => '',
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const checks = auditReviewer(db);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 9: writer-reviewer サイクル監査 + 改善ループ
    // -----------------------------------------------------------------------
    {
      key: 'phase9_writer_reviewer_cycle',
      phase: 'Phase 9: writer-reviewer サイクル',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, 'report.md');
          return [
            '## 目的',
            '',
            'writer-reviewer サイクルの機械監査を実行し、問題があれば修正ループを回す。',
            '',
            '## 手順',
            '',
            '1. 機械監査を実行する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'audit.ts')} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
            '```',
            '',
            '2. 監査が pass なら完了',
            '',
            '3. 監査が fail/error の場合、review_findings を集約する:',
            '   - `db.ts snapshot --cycle writer-reviewer` で全 findings を取得',
            '   - `must_fix` / `research_needed` / `suggestions` に分類',
            '   - 重複や類似の指摘を統合',
            '',
            '4. `must_fix` がある場合:',
            '   - 集約した must_fix を 1 つのプロンプトにまとめ、Writer に再委譲',
            '   - `suggestions` のうち重要と判断したものも含める',
            '   - Writer は `db.ts snapshot --cycle writer-reviewer` を再取得して report.md を更新',
            '   - 修正後、全観点を再レビューする',
            '   - 最大 3 回まで再委譲。3 回を超えたら人間に判断を仰ぐ',
            '',
            '5. `research_needed` がある場合:',
            '   - `target_question_id` ごとにグルーピング',
            '   - 問いごとに Researcher SubAgent を起動（`round_number` をインクリメント）',
            '   - 追加調査後、全観点を再レビューする',
            '   - 最大 3 回まで追加調査。3 回を超えたら人間に判断を仰ぐ',
            '',
            '6. 改善ループの結果は `iterations` テーブルに記録する:',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'db.ts')} iteration save --db-path ${ctx.artifactDbPath} --data '{"loop_number": 1, "iteration_type": "writer_fix", "summary": "..."}'`,
            '```',
            '',
            '7. 修正ループ後、再度サイクル監査を実行する',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
            `- report.md: ${reportPath}`,
            `- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`,
            '',
            '## 禁止事項',
            '',
            '- must_fix が残っているのに次のフェーズに進まない',
            '- Writer → Reviewer ループは 1 回の report.md 更新あたり最大 3 回まで',
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, 'report.md');
          const checks = auditWriterReviewerCycle(db, reportPath);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 10: 最終レポート確定
    // -----------------------------------------------------------------------
    {
      key: 'phase10_finalize',
      phase: 'Phase 10: 最終レポート確定',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, 'report.md');
          return [
            '## 目的',
            '',
            'report.md を最終更新し、lint を実行してレポートを確定する。',
            '',
            '## 手順',
            '',
            '1. `lint.ts` で report.md をフォーマット・lint する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'lint.ts')} --file ${reportPath}`,
            '```',
            '',
            '2. 最終サイクル監査を実行する',
            '',
            '```bash',
            `bun run ${join(SCRIPTS_DIR, 'audit.ts')} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
            '```',
            '',
            '3. lint エラーがある場合は Writer に明示的な修正を依頼（最大 3 回）',
            '4. レポートに未解決の問い・次のアクション・中間まとめ・SearXNG 信頼性注意書きが含まれていないか確認',
            '5. report.md 全文はセッションに出さない',
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
            `- report.md: ${reportPath}`,
            `- 試行回数: ${ctx.attemptNumber}/${ctx.maxRetries}`,
          ].join('\n');
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: 'error', reasons: ['No artifact DB path'] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, 'report.md');
          const checks = auditWriterReviewerCycle(db, reportPath);

          const content = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : null;
          if (content) {
            const forbiddenWords = ['次のアクション', '未解決の問い', '中間まとめ', 'SearXNG 信頼性'];
            const found = forbiddenWords.filter((w) => content.includes(w));
            checks.push({
              check_name: 'report_no_forbidden_content',
              status: found.length === 0 ? 'pass' : 'fail',
              detail: found.length === 0 ? 'no forbidden content' : `found: ${found.join(', ')}`,
            });
          }

          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 11: 完了報告
    // -----------------------------------------------------------------------
    {
      key: 'phase11_completion',
      phase: 'Phase 11: 完了報告',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_command',
        buildPrompt: (ctx: PromptCtx) => {
          return [
            '## 完了報告',
            '',
            '調査が完了したことを簡潔に報告する。report.md の全文は出力しない。',
            '',
            '以下の形式で完了メッセージを出力する:',
            '',
            `調査が完了しました。N 件の情報源を確認しました。レポートは ${join(ctx.sessionDir, 'report.md')} に保存しました。`,
            '',
            '## セッション情報',
            '',
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- research.db: ${ctx.artifactDbPath}`,
          ].join('\n');
        },
      },
      check: (_ctx: CheckCtx): CheckResult => {
        return { status: 'pass', reasons: ['completion acknowledged'] };
      },
    },
  ],
};

export default def;
