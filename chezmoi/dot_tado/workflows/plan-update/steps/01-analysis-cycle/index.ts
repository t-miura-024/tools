import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { grillStep } from "./01.01-grill.ts";
import { confirmAnalysisStep } from "./01.02-confirm-analysis.ts";
import { judgeAnalysisStep } from "./01.03-judge-analysis.ts";

// -----------------------------------------------------------------
// Loop: 分析サイクル（confirm-analysis の revise 置換。旧 reviseTargetStep=grill を始点に据える）
//   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
//   マーカーを残して pass で脱出し、loop 外の analysis-exhausted へ渡す。
// -----------------------------------------------------------------
export const analysisCycleStep: LoopStepDef = {
  key: "analysis-cycle",
  phase: "分析サイクル",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [grillStep, confirmAnalysisStep, judgeAnalysisStep],
};
