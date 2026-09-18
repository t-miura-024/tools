import type { ConditionCtx, GateAnswers } from "tado";
import { GATE_SKIP_CONDITIONS } from "./gate-skip-conditions.ts";
import { gateDecisionValue } from "./gate-decision-value.ts";

/// 世代を考慮した gate 回答値の読み取り（全読み取りの単一 chokepoint）。
/// skip されたゲートの旧回答は undefined（未回答扱い）として返し、幽霊差し戻しを作らない。
/// skip 判定の分岐を直接テストするため export する。
export function currentGateDecision(
  gateAnswers: GateAnswers,
  ctx: ConditionCtx,
  stepKey: string,
): string | undefined {
  const skipWhen = GATE_SKIP_CONDITIONS[stepKey];
  if (skipWhen && !skipWhen(ctx)) return undefined;
  return gateDecisionValue(gateAnswers, stepKey);
}
