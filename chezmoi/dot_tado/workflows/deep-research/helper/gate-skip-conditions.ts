import type { ConditionCtx } from "tado";
import { isPlanApprovalExhausted } from "./is-plan-approval-exhausted.ts";

/// gateAnswers 世代管理の skip 判定 registry（plan-run の condition-registry 方式）。
/// condition を持つゲートは step の condition と同一関数を登録する（写像ドリフト防止）。
/// 常時提示の loop 内ゲートは登録不要（常に最新回答が現世代）。
/// テストから参照するため export する（registry 更新強制テスト用）。
export const GATE_SKIP_CONDITIONS: Record<string, (ctx: ConditionCtx) => boolean> = {
  "plan-approval-exhausted-gate": isPlanApprovalExhausted,
};
