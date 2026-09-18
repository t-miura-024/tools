import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { createCollectVerdictStep } from "../../../../review-diff/helper/create-collect-verdict-step.ts";

// Step 6: 人間レビュー待機は人間サイクル（外側 loop 本体）へ移動した。
// 自律ループ完走後に人間がレビューし、judge-human が gateAnswers を読んで分岐する。

// -------------------------------------------------------------------
// verdict は非破壊で突合する。異常は tado の onFail に委ねる。
// plan-run は人間承認までセッションを保持するため humanReviewPending=true で生成する。
// -------------------------------------------------------------------
const baseCollectVerdictStep = createCollectVerdictStep(true);

export const collectVerdictPlanStep: TaskStepDef = {
  ...baseCollectVerdictStep,
  phase: "verdict 収集",
  maxRetries: 0,
  onFail: { action: "escalate" },
};
