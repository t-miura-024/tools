import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { ParallelStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditReviewer } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 8: レビュー (Reviewer, parallel)
// -----------------------------------------------------------------------
export const phase8ReviewerStep: ParallelStepDef = {
  key: "phase8-reviewer",
  phase: "Phase 8: レビュー",
  type: "parallel",
  maxRetries: 3,
  onFail: { action: "escalate" },
  parallel: {
    subtasks: (["coverage", "sources", "accuracy", "structure", "citations"] as const).map(
      (aspect) => ({
        key: `reviewer-${aspect}`,
        subagentType: "mt-deep-research-reviewer",
        readonly: true,
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, "report.md");
          const aspectDesc: Record<string, string> = {
            coverage: "調査範囲の網羅性：すべての問いがレポートでカバーされているか",
            sources: "情報源の品質：引用が適切で信頼性の高いソースが使われているか",
            accuracy: "事実の正確性：evidence とレポートの記述が一致しているか",
            structure: "構造の妥当性：必須セクションが揃い、論理的な流れになっているか",
            citations: "引用の整合性：番号引用 [N] が sources.source_number と一致しているか",
          };
          return buildStepPrompt({
            purpose: [`「${aspect}」観点で report.md をレビューする。`],
            criteria: ["auditReviewer が pass（all_aspects_reviewed / all_reviews_have_findings）"],
            approach: [
              {
                title: `観点説明: ${aspect}`,
                content: [aspectDesc[aspect] ?? "", ""],
              },
              {
                title: "入力の取得",
                content: [
                  "以下のスナップショットから report.md と research.db の内容を取得する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
                ],
              },
            ],
            output: [
              "`db.ts review save` で JSON を保存する。findings は以下のカテゴリで分類する:",
              "- `must_fix`: 修正が必須の問題",
              "- `research_needed`: 追加調査が必要な項目（`target_question_id` を必ず付与）",
              "- `suggestions`: 任意の改善提案",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} review save --db-path ${ctx.artifactDbPath} --data '{ ... }'`,
              "```",
            ],
            policy: ["- 担当観点以外の指摘を行わない", "- ファイルを直接編集しない"],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md: ${reportPath}`,
              `観点: ${aspect}`,
            ],
          });
        },
      }),
    ),
  },
  task: {
    action: "run_subagent",
    buildPrompt: (_ctx: PromptCtx) =>
      buildStepPrompt({ purpose: [], criteria: [], approach: [], output: [] }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const checks = auditReviewer(db);
      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
