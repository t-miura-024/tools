import { describe, test, expect } from "bun:test";
import { buildReviewCoverage } from "./build-review-coverage.ts";

describe("buildReviewCoverage (coverage 正典の組み立て)", () => {
  test("割り当てと差分 Map から reviewers・diffFiles・行数総和を組み立てる", () => {
    const coverage = buildReviewCoverage(
      [[{ id: "req-1" }, { id: "req-2" }], [{ id: "logic-2" }]],
      new Map([
        ["src/b.ts", new Set([3])],
        ["src/a.ts", new Set([1, 2])],
      ]),
    );
    expect(coverage).toEqual({
      reviewers: [
        { index: 1, perspectives: ["req-1", "req-2"] },
        { index: 2, perspectives: ["logic-2"] },
      ],
      diffFiles: ["src/a.ts", "src/b.ts"],
      diffAddedLines: 3,
    });
  });

  test("空の割り当て・空差分はゼロ値になる", () => {
    expect(buildReviewCoverage([], new Map())).toEqual({
      reviewers: [],
      diffFiles: [],
      diffAddedLines: 0,
    });
  });
});
