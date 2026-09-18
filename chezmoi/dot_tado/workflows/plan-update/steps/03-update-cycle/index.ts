import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { draftBodyStep } from "./03.01-draft-body.ts";
import { confirmUpdateStep } from "./03.02-confirm-update.ts";
import { judgeUpdateStep } from "./03.03-judge-update.ts";

// -----------------------------------------------------------------
// Loop: 更新サイクル（confirm-update の revise 置換。旧 reviseTargetStep=draft-body を始点に据える）
//   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
//   マーカーを残して pass で脱出し、loop 外の update-exhausted へ渡す。
// -----------------------------------------------------------------
export const updateCycleStep: LoopStepDef = {
  key: "update-cycle",
  phase: "更新サイクル",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [draftBodyStep, confirmUpdateStep, judgeUpdateStep],
};
