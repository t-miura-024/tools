import type { ConditionCtx } from "tado";
import { readPlanReviewFindings } from "./review-findings.ts";
import { REVIEW_FIX_MAX_ITERATIONS } from "./review-limits.ts";

/// 内側 review-fix-cycle が上限に達し、かつ must が残っているか。
/// 不正な findings は fail-closed で throw する（ゲートを黙って skip しない）。
export function isReviewFixExhausted(ctx: ConditionCtx): boolean {
  const result = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
  if (!result.valid || !result.parsed) {
    throw new Error(
      `review-findings.json を検証できないため自動レビュー上限を判定できません: ${result.error ?? "invalid findings"}`,
    );
  }
  return result.parsed.counts.must > 0 && result.parsed.cycleRound >= REVIEW_FIX_MAX_ITERATIONS;
}
