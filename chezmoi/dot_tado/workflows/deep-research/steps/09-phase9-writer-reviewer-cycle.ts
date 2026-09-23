import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditWriterReviewerCycle } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 9: writer-reviewer サイクル監査 + 改善ループ
// -----------------------------------------------------------------------
export const phase9WriterReviewerCycleStep: TaskStepDef = {
  key: "phase9-writer-reviewer-cycle",
  phase: "Phase 9: writer-reviewer サイクル",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const reportPath = join(ctx.sessionDir, "report.md");
      return buildStepPrompt({
        purpose: ["writer-reviewer サイクルの機械監査を実行し、問題があれば修正ループを回す。"],
        criteria: [
          "auditWriterReviewerCycle が pass（auditWriter + auditReviewer + no_unresolved_must_fix + research_needed_addressed）",
        ],
        approach: [
          {
            title: "監査の実行と完了判定",
            content: [
              {
                title: "1. 機械監査の実行",
                content: [
                  "機械監査を実行する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
                  "",
                ],
              },
              {
                title: "2. pass 時の完了",
                content: ["監査が pass なら完了", ""],
              },
            ],
          },
          {
            title: "findings の集約と再委譲",
            content: [
              {
                title: "3. review_findings の集約",
                content: [
                  "監査が fail/error の場合、review_findings を集約する:",
                  "   - `db.ts snapshot --cycle writer-reviewer` で全 findings を取得",
                  "   - `must_fix` / `research_needed` / `suggestions` に分類",
                  "   - 重複や類似の指摘を統合",
                  "",
                ],
              },
              {
                title: "4. must_fix への対応",
                content: [
                  "`must_fix` がある場合:",
                  "   - 集約した must_fix を 1 つのプロンプトにまとめ、Writer に再委譲",
                  "   - `suggestions` のうち重要と判断したものも含める",
                  "   - Writer は `db.ts snapshot --cycle writer-reviewer` を再取得して report.md を更新",
                  "   - 修正後、全観点を再レビューする",
                  "   - 最大 3 回まで再委譲。3 回を超えたら人間に判断を仰ぐ",
                  "",
                ],
              },
              {
                title: "5. research_needed への対応",
                content: [
                  "`research_needed` がある場合:",
                  "   - `target_question_id` ごとにグルーピング",
                  "   - 問いごとに Researcher SubAgent を起動（`round_number` をインクリメント）",
                  "   - 追加調査後、全観点を再レビューする",
                  "   - 最大 3 回まで追加調査。3 回を超えたら人間に判断を仰ぐ",
                  "",
                ],
              },
            ],
          },
          {
            title: "記録と再監査",
            content: [
              {
                title: "6. 改善ループの記録",
                content: [
                  "改善ループの結果は `iterations` テーブルに記録する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} iteration save --db-path ${ctx.artifactDbPath} --data '{"loop_number": 1, "iteration_type": "writer_fix", "summary": "..."}'`,
                  "```",
                  "",
                ],
              },
              {
                title: "7. サイクル監査の再実行",
                content: ["修正ループ後、再度サイクル監査を実行する"],
              },
            ],
          },
        ],
        output: ["監査結果。未解決があれば `iterations` テーブルに記録した改善ループの結果。"],
        policy: [
          "- must_fix が残っているのに次のフェーズに進まない",
          "- Writer → Reviewer ループは 1 回の report.md 更新あたり最大 3 回まで",
        ],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `report.md: ${reportPath}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const reportPath = join(ctx.sessionDir, "report.md");
      const checks = auditWriterReviewerCycle(db, reportPath);
      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
