import { describe, test, expect } from "bun:test";
import { isRoundLimitReached } from "./is-round-limit-reached.ts";
import { REVIEW_ROUND_LIMIT } from "./review-round-limit.ts";

describe("isRoundLimitReached (verdict round 上限)", () => {
  test("round > 5 は通過していても true（上限超過は人間判断へ）", () => {
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT + 1, passed: true })).toBe(true);
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT + 1, passed: false })).toBe(true);
  });

  test("round = 5 は未通過のみ true", () => {
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT, passed: false })).toBe(true);
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT, passed: true })).toBe(false);
  });

  test("round < 5 は常に false", () => {
    expect(isRoundLimitReached({ round: 1, passed: false })).toBe(false);
    expect(isRoundLimitReached({ round: 2, passed: false })).toBe(false);
  });
});
