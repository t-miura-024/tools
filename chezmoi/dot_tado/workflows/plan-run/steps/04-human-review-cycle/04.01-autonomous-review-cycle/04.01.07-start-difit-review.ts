import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { startDifitReviewStep } from "../../../../review-diff/steps/03-human-review-loop/03.04-start-difit-review.ts";

// -------------------------------------------------------------------
// Step 5.6: difit レビュー起動（review-diff から import — B相入口。
//           start + コメント注入 + URL 提示を 1 ステップで行う）
// -------------------------------------------------------------------
export const startDifitReviewPlanStep: TaskStepDef = {
  ...startDifitReviewStep,
  phase: "difit レビュー起動",
};
