import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { REVIEW_ROUND_LIMIT } from "../../../../shared/review-helpers/review-round-limit";
import { applyFeedbackStep } from "./04.01.01-apply-feedback.ts";
import { executeWorkStep } from "./04.01.02-execute-work.ts";
import { resolveEffortPlanStep } from "./04.01.03-resolve-effort.ts";
import { runReviewersPlanStep } from "./04.01.04-run-reviewers.ts";
import { normalizeFindingsPlanStep } from "./04.01.05-normalize-findings.ts";
import { agentVerdictStep } from "./04.01.06-agent-verdict.ts";
import { startDifitReviewPlanStep } from "./04.01.07-start-difit-review.ts";
import { collectVerdictPlanStep } from "./04.01.08-collect-verdict.ts";

// -------------------------------------------------------------------
// 内外とも最大5回。自律上限は通常通過で人間レビューへ渡す。
// 人間側が全回差し戻した場合だけ onExhausted によりエンジンが paused にする。
// effort.round は normalize 前に ctx.loop.iteration から設定するため、
// 外側巻き戻しによる内側 iteration=1 への初期化が予算再付与になる。
// -------------------------------------------------------------------
export const autonomousReviewCycleStep: LoopStepDef = {
  key: "autonomous-review-cycle",
  phase: "自律サイクル",
  type: "loop",
  maxIterations: REVIEW_ROUND_LIMIT,
  onExhausted: "escalate",
  body: [
    applyFeedbackStep,
    executeWorkStep,
    resolveEffortPlanStep,
    runReviewersPlanStep,
    normalizeFindingsPlanStep,
    agentVerdictStep,
    startDifitReviewPlanStep,
    collectVerdictPlanStep,
  ],
};
