import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { brainstormStep } from "./01.01-brainstorm.ts";
import { dedupCheckStep } from "./01.02-dedup-check.ts";
import { reviewScoreStep } from "./01.03-review-score.ts";
import { presentGateStep } from "./01.04-present-gate.ts";
import { judgePresentStep } from "./01.05-judge-present.ts";

// ---------------------------------------------------------------------------
// 候補サイクル（human gate revise の loop 置換）
//   present-gate の request_changes 差し戻しは、旧 revise 相当として
//   loop の判定 continue で brainstorm 先頭へ巻き戻る（再作業→再提示）。
//   巻き戻し先は旧 `reviseTargetStep: "brainstorm"` を本体先頭に据える
//   （`git show HEAD:...` で復元。worktree では revise 撤去済みのため request_changes が後継語彙）。
//   上限（3 反復）到達時は judge が pass で loop を抜け、loop 外の
//   present-exhausted-gate（approve/abort のみ）で人間が受容・中断を選ぶ。
//   内側 present-gate は無条件で毎反復再実行されるため常に最新回答が現世代であり、
//   世代管理の registry は設けない。全読み取りは gateDecisionValue /
//   gateDecisionInput 純粋関数に一本化する（幽霊差し戻しを作らない）。
//   confirm-done は語彙なしのため対象外・変更しない。
// NOTE(arch-2): buildStepPrompt は shared/prompt.ts 経由に集約済み（純粋フォーマッターであり ADR-0019 の StepDef 限定と競合しない）。
// ---------------------------------------------------------------------------
// 候補サイクル（human gate revise の loop 置換。旧 reviseTargetStep
// = brainstorm を本体先頭に据える）
//   maxIterations は 3、onExhausted は escalate。上限到達時は judge の pass 抜けを
//   経て loop 外の present-exhausted-gate（approve/abort のみ）へ渡る。
//   反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
//   brainstorm へ巻き戻る（report の nextAction は repeat）。
//   loop 外で check が continue を返すとエンジンが fail-fast する。
// ---------------------------------------------------------------------------
export const candidateCycleStep: LoopStepDef = {
  key: "candidate-cycle",
  phase: "候補サイクル",
  type: "loop",
  maxIterations: 3,
  onExhausted: "escalate",
  body: [brainstormStep, dedupCheckStep, reviewScoreStep, presentGateStep, judgePresentStep],
};
