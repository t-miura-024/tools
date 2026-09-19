import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { REVIEW_ROUND_LIMIT } from "../../../shared/review-helpers/review-round-limit";
import { autonomousReviewCycleStep } from "./04.01-autonomous-review-cycle/index.ts";
import { awaitHumanReviewPlanStep } from "./04.02-await-human-review.ts";
import { judgeHumanStep } from "./04.03-judge-human.ts";

// -------------------------------------------------------------------
// 内外とも最大5回。自律上限は通常通過で人間レビューへ渡す。
// 人間側が全回差し戻した場合だけ onExhausted によりエンジンが paused にする。
// effort.round は normalize 前に ctx.loop.iteration から設定するため、
// 外側巻き戻しによる内側 iteration=1 への初期化が予算再付与になる。
// -------------------------------------------------------------------
export const humanReviewCycleStep: LoopStepDef = {
  key: "human-review-cycle",
  phase: "人間サイクル",
  type: "loop",
  maxIterations: REVIEW_ROUND_LIMIT,
  onExhausted: "escalate",
  body: [autonomousReviewCycleStep, awaitHumanReviewPlanStep, judgeHumanStep],
};
