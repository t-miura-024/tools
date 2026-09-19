import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { phase3PlannerStep } from "./02.01-phase3-planner.ts";
import { phase3bPlanApprovalStep } from "./02.02-phase3b-plan-approval.ts";
import { judgePlanApprovalStep } from "./02.03-judge-plan-approval.ts";

// ---------------------------------------------------------------------------
// 計画承認サイクル（human gate revise の loop 置換）
//   phase3b-plan-approval の request_changes 差し戻しは、旧 revise 相当として
//   loop の判定 continue で phase3-planner 先頭へ巻き戻る（再作業→再提示）。
//   巻き戻し先は旧 `reviseTargetStep: "phase3-planner"` を本体先頭に据える
//   （`git show HEAD:...` で復元。worktree では revise 撤去済みのため request_changes が後継語彙）。
//   上限（3 反復）到達時は judge が pass で loop を抜け、loop 外の
//   plan-approval-exhausted-gate（approve/abort のみ）で人間が受容・中断を選ぶ。
//   世代管理は GATE_SKIP_CONDITIONS registry（plan-run の condition-registry 方式）
//   で行い、skip ゲートの旧回答を現世代の判定に拾わない。全読み取りは
//   currentGateDecision / currentGateInput に一本化する（幽霊差し戻しを作らない）。
// ---------------------------------------------------------------------------
// 計画承認サイクル（human gate revise の loop 置換。旧 revise 相当の巻き戻し先
// = phase3-planner を本体先頭に据える）
//   maxIterations は 3、onExhausted は escalate。上限到達時は judge の pass 抜けを
//   経て loop 外の plan-approval-exhausted-gate（approve/abort のみ）へ渡る。
//   反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
//   phase3-planner へ巻き戻る（report の nextAction は repeat）。
//   loop 外で check が continue を返すとエンジンが fail-fast する。
// ---------------------------------------------------------------------------
export const planApprovalCycleStep: LoopStepDef = {
  key: "plan-approval-cycle",
  phase: "計画承認サイクル",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [phase3PlannerStep, phase3bPlanApprovalStep, judgePlanApprovalStep],
};
