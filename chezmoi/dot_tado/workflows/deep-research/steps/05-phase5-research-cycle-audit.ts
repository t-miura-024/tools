import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditResearchCycle } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 5: research サイクル監査
// -----------------------------------------------------------------------
export const phase5ResearchCycleAuditStep: TaskStepDef = {
  key: "phase5-research-cycle-audit",
  phase: "Phase 5: research サイクル監査",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "research サイクル全体の機械監査を実行し、問題があれば Auditor に意味整合性評価を依頼する。",
        ],
        criteria: ["auditResearchCycle が pass"],
        approach: [
          {
            title: "手順",
            content: [
              "1. 機械監査を実行する",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
              "```",
              "",
              "2. 監査が pass なら完了",
              "3. 監査が fail/error の場合:",
              "   - `mt-deep-research-auditor` SubAgent を呼び出して意味的整合性を評価",
              "   - Auditor には `db.ts snapshot --cycle research` の出力を渡す",
              "   - 監査結果は workflow engine の step_attempts に自動保存される",
              "   - 必要に応じて Researcher に追加調査を依頼",
              "",
            ],
          },
          {
            title: "監査コマンド",
            content: [
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
              "```",
            ],
          },
        ],
        output: ["research サイクル監査の結果。fail/error 時は Auditor の評価と追加調査の依頼。"],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const checks = auditResearchCycle(db);
      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
