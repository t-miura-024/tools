import type { LoopStepDef } from "tado/types/workflow-def.ts";
import { grillStep } from "./01.01-grill.ts";
import { draftBodyStep } from "./01.02-draft-body.ts";
import { reviewBodyStep } from "./01.03-review-body.ts";
import { judgeMustStep } from "./01.04-judge-must.ts";
import { reviewFixExhaustedStep } from "./01.05-review-fix-exhausted.ts";
import { judgeFixExhaustedStep } from "./01.06-judge-fix-exhausted.ts";
import { prepareStep } from "./01.07-prepare.ts";
import { reviewGateStep } from "./01.08-review-gate.ts";
import { judgeReviewStep } from "./01.09-judge-review.ts";
import {
  REVIEW_CYCLE_MAX_ITERATIONS,
  REVIEW_FIX_MAX_ITERATIONS,
} from "../../helper/review-limits.ts";

// -----------------------------------------------------------------
// 外側: 人間差し戻しループ
//   review-fix-cycle（自動 review→grill）を内側に持つ。
//   must=0 なら内側を通常通過し、prepare → review-gate（最終承認）へ進む。
//   review-gate の request_changes は外側 loop の continue で
//   review-fix-cycle 先頭（grill）へ巻き戻る。内側 loop の反復状態は
//   エンジンにより初期化される。
//   外側上限時は judge-review が枯渇マーカーを残して pass し、
//   loop 外の review-exhausted で人間が判断する。
// -----------------------------------------------------------------
// 内側: 自動レビュー修正ループ
//   review-body が独立レビュアーの findings を生成し、judge-must が
//   must>0 なら continue で grill へ巻き戻す。上限時は pass で抜け、
//   review-fix-exhausted（人間ゲート）で追加ラウンド/中断を選ぶ。
//   追加ラウンドは外側 loop の continue（外側枠を1回消費）で実行する。
// -----------------------------------------------------------------
export const reviewFixCycleStep: LoopStepDef = {
  key: "review-fix-cycle",
  phase: "自動レビュー修正サイクル",
  type: "loop",
  maxIterations: REVIEW_FIX_MAX_ITERATIONS,
  onExhausted: "escalate",
  body: [grillStep, draftBodyStep, reviewBodyStep, judgeMustStep],
};

export const reviewCycleStep: LoopStepDef = {
  key: "review-cycle",
  phase: "レビューサイクル",
  type: "loop",
  maxIterations: REVIEW_CYCLE_MAX_ITERATIONS,
  onExhausted: "escalate",
  body: [
    reviewFixCycleStep,
    reviewFixExhaustedStep,
    judgeFixExhaustedStep,
    prepareStep,
    reviewGateStep,
    judgeReviewStep,
  ],
};
