import { describe, test, expect } from "bun:test";
import { REVIEW_ROUND_LIMIT } from "./review-round-limit.ts";
import { validateEffort } from "./validate-effort.ts";

describe("validateEffort (review-diff / plan-run 共有の effort 検証)", () => {
  const valid = { width: "medium", depth: "medium", base: "main", round: 1 };

  test("契約を満たす effort は pass", () => {
    expect(validateEffort(valid)).toEqual({
      status: "pass",
      width: "medium",
      depth: "medium",
      round: 1,
      overflow: false,
    });
  });

  test("round > LIMIT は fail、allowRoundOverflow で pass（overflow=true）", () => {
    const over = { ...valid, round: REVIEW_ROUND_LIMIT + 1 };
    const failed = validateEffort(over);
    expect(failed.status).toBe("fail");
    expect(failed.status === "fail" ? failed.reasons.join("\n") : "").toContain(
      "round limit exceeded",
    );
    expect(validateEffort(over, { allowRoundOverflow: true })).toEqual({
      status: "pass",
      width: "medium",
      depth: "medium",
      round: REVIEW_ROUND_LIMIT + 1,
      overflow: true,
    });
  });

  test("width / depth / base の契約は allowRoundOverflow でも同じ fail を返す", () => {
    const invalids: Array<Record<string, unknown>> = [
      { ...valid, width: "super", round: 4 },
      { ...valid, depth: "super", round: 4 },
      { ...valid, base: "bad ref", round: 4 },
    ];
    for (const invalid of invalids) {
      const result = validateEffort(invalid, { allowRoundOverflow: true });
      expect(result.status).toBe("fail");
    }
  });

  test("JSON オブジェクトでなければ error", () => {
    expect(validateEffort(undefined).status).toBe("error");
    expect(validateEffort([valid]).status).toBe("error");
  });

  test("round は 1 以上の整数必須（欠落・0・小数・文字列は fail。無音の 1 フォールバックをしない）", () => {
    // round=0 / 2.5 / "3" / 欠落は、collect_context check / advanceReviewRound と
    // 同じ判定（fail）になる。round 未指定を 1 にフォールバックすると、同じ effort.json が
    // review-diff では pass、plan-run では fail という経路差が生まれる。
    for (const round of [0, -1, 2.5, "3", undefined, null]) {
      const result = validateEffort({ width: "low", depth: "max", round });
      expect(result.status).toBe("fail");
      if (result.status === "fail") {
        expect(result.reasons.join("\n")).toContain("round");
      }
    }
    // 境界値: round=1 は pass
    expect(validateEffort({ width: "low", depth: "max", round: 1 }).status).toBe("pass");
  });
});
