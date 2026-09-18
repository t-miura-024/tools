import type { VerdictJson } from "./types.ts";
import { REVIEW_ROUND_LIMIT } from "./review-round-limit.ts";

/// verdict がラウンド上限（round > 3、または round = 3 かつ未通過）に達しているか（純粋関数）。
/// 上限は再実行では解消しないため、消費者は human gate で継続/中止を人間に委ねる。
export function isRoundLimitReached(verdict: Pick<VerdictJson, "round" | "passed">): boolean {
  return (
    verdict.round > REVIEW_ROUND_LIMIT || (verdict.round === REVIEW_ROUND_LIMIT && !verdict.passed)
  );
}
