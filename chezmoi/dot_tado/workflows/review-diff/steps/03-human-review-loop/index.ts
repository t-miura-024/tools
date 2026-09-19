import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { HUMAN_REVIEW_LOOP_KEY } from "../../helper/human-review-loop-key.ts";
import { verifyFixStep } from "./03.01-verify-fix.ts";
import { runReviewersStep } from "./03.02-run-reviewers.ts";
import { normalizeFindingsStep } from "./03.03-normalize-findings.ts";
import { startDifitReviewStep } from "./03.04-start-difit-review.ts";
import { awaitHumanReviewStep } from "./03.05-await-human-review.ts";
import { collectVerdictStep } from "./03.06-collect-verdict.ts";
import { judgeHumanReviewStep } from "./03.07-judge-human-review.ts";

// -------------------------------------------------------------------
// human-review-loop: 人間レビューの修正ループ（revise 置換）。
//   maxIterations=3・onExhausted=escalate。judge-human-review の判定 continue で
//   本体先頭（verify-fix）へ巻き戻る。枯渇時は後段の human-exhausted-gate で判断する。
// -------------------------------------------------------------------
export const humanReviewLoopStep: LoopStepDef = {
  key: HUMAN_REVIEW_LOOP_KEY,
  phase: "人間レビューループ",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [
    verifyFixStep,
    runReviewersStep,
    normalizeFindingsStep,
    startDifitReviewStep,
    awaitHumanReviewStep,
    collectVerdictStep,
    judgeHumanReviewStep,
  ],
};
