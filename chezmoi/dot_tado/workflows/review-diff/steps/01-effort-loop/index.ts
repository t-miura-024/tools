import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { EFFORT_LOOP_KEY } from "../../helper/effort-loop-key.ts";
import { resolveEffortStep } from "./01.01-resolve-effort.ts";
import { collectContextStep } from "./01.02-collect-context.ts";
import { judgeEffortStep } from "./01.03-judge-effort.ts";

// -------------------------------------------------------------------
// effort-loop: effort 解決の修正ループ（revise 置換）。
//   maxIterations=3・onExhausted=escalate。judge-effort の判定 continue で
//   本体先頭（resolve-effort）へ巻き戻る。枯渇時は後段の effort-exhausted-gate
//   （condition が request_changes のときだけ提示）で人間が判断する。
// -------------------------------------------------------------------
export const effortLoopStep: LoopStepDef = {
  key: EFFORT_LOOP_KEY,
  phase: "effort 解決ループ",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [resolveEffortStep, collectContextStep, judgeEffortStep],
};
