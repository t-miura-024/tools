import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { runReviewersStep } from "../../../../review-diff/steps/03-human-review-loop/03.02-run-reviewers.ts";
import { collectPlanReviewContext } from "../../../../shared/collect-plan-review-context/collect-plan-review-context";

// -------------------------------------------------------------------
// Step 5: 検証者起動（review-diff から import — 旧 review_work 置換）
// -------------------------------------------------------------------
export const runReviewersPlanStep: TaskStepDef = {
  ...runReviewersStep,
  phase: "検証者起動",
  // ADR-0019: レビュー判断は Step import を維持。plan-run の収集専用
  // collect-context は撤去し、プロンプト生成前に収集・機械検証を完結する。
  beforeStep: collectPlanReviewContext,
};
