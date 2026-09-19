import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditResearchCycle } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 6: チェックポイント
// -----------------------------------------------------------------------
export const phase6CheckpointStep: TaskStepDef = {
  key: "phase6-checkpoint",
  phase: "Phase 6: チェックポイント",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: ["off_topic_questions をユーザーに提示し、追加調査するか判断を仰ぐ。"],
        criteria: ["auditResearchCycle が pass（off_topic_resolved）"],
        approach: [
          {
            title: "手順",
            content: [
              "1. off_topic_questions を取得する:",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle research --db-path ${ctx.artifactDbPath}`,
              "```",
              "",
              "2. スナップショットの `off_topic_questions` を確認する",
              "3. 各 off_topic_question の内容をユーザーに提示し、追加調査するか確認する",
              "4. ユーザーの判断に基づいて `decision` を更新する:",
              "   - `include`: 追加調査に含める → Researcher で追加調査",
              "   - `exclude`: 対象外とする",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} evidence save --db-path ${ctx.artifactDbPath} --data '{"question_id": <ID>, "round_number": <N>, "off_topic_questions": [{"content": "...", "decision": "include"}]}'`,
              "```",
              "",
              "5. ユーザーが `include` を選択した off_topic_question があれば、Researcher に追加調査を依頼する",
            ],
          },
        ],
        output: ["off_topic_questions へのユーザー判断（include/exclude）の反映。"],
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
      return toCheckResult(auditResearchCycle(db));
    } finally {
      db.close();
    }
  },
};
