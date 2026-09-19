import type { InitCtx, WorkflowDef } from "tado";
import { loadConfig } from "../shared/plan-init-config/load-config";
import { identifyPlanStep } from "./steps/01-identify-plan.ts";
import { startExecutionStep } from "./steps/02-start-execution.ts";
import { transcribeDocsStep } from "./steps/03-transcribe-docs.ts";
import { humanReviewCycleStep } from "./steps/04-human-review-cycle/index.ts";
import { finalizeDoneStep } from "./steps/05-finalize-done.ts";

const def: WorkflowDef = {
  id: "plan-run",
  description:
    "GitHub Issueベースの計画を選択し実行して履歴を更新するワークフロー。実行・検証・修正サイクルを管理し計画を完遂させる。",

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
    identifyPlanStep,
    startExecutionStep,
    transcribeDocsStep,
    humanReviewCycleStep,
    finalizeDoneStep,
  ],
};

export default def;
