import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { grillStep } from "./01.01-grill.ts";
import { draftBodyStep } from "./01.02-draft-body.ts";
import { reviewBodyStep } from "./01.03-review-body.ts";
import { prepareStep } from "./01.04-prepare.ts";
import { reviewGateStep } from "./01.05-review-gate.ts";
import { judgeReviewStep } from "./01.06-judge-review.ts";

// -----------------------------------------------------------------
// Loop: レビューサイクル（human gate revise 置換）
//   差し戻し→再作業→再提示は loop の continue 巻き戻しで再現する。
//   本体 = 作業ステップ群（grill 先頭）＋ review-gate ＋ judge-review 末尾。
//   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
//   マーカーを残して pass で脱出し、loop 外の review-exhausted へ渡す。
//   対応エンジン: tado#24（type: "loop" / 判定 continue / onExhausted /
//   gateAnswers 注入）以降。loop 外で check が continue を返すとエンジンが
//   fail-fast するため、loop 外ステップの check は continue を返さない。
// -----------------------------------------------------------------
export const reviewCycleStep: LoopStepDef = {
  key: "review-cycle",
  phase: "レビューサイクル",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [grillStep, draftBodyStep, reviewBodyStep, prepareStep, reviewGateStep, judgeReviewStep],
};
