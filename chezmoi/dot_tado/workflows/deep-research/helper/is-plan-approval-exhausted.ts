import type { ConditionCtx } from "tado";
import { readPlanApprovalExhaustedMarker } from "./read-plan-approval-exhausted-marker.ts";

/// loop 枯渇の検出（plan-approval-exhausted-gate の condition 本体）。
/// judge が上限到達時に書き残す枯渇マーカーの有無で判定する（fail-closed）。
/// gateAnswers 最新値のみではクリア時に常時非提示となるため使わない。
/// マーカー不在 → false（正常 pass で非提示）。破損・不一致 → throw（escalate）。
export function isPlanApprovalExhausted(ctx: ConditionCtx): boolean {
  const marker = readPlanApprovalExhaustedMarker(ctx.sessionDir);
  if (marker === null) return false;
  return true;
}
