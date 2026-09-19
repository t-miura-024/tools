import { describe, test, expect } from "bun:test";
import { validateFindingsJson } from "./validate-findings-json.ts";

describe("findings.json coverage 併記 (record-only)", () => {
  const base = {
    round: 1,
    width: "medium",
    depth: "medium",
    findings: [],
    counts: { must: 0, should: 0, want: 0 },
  };

  test("coverage なしは valid（旧成果物との後方互換）", () => {
    const result = validateFindingsJson(JSON.stringify(base));
    expect(result.valid).toBe(true);
  });

  test("正しい coverage は valid で parsed に維持される", () => {
    const coverage = {
      reviewers: [
        { index: 1, perspectives: ["req-1", "req-2"] },
        { index: 2, perspectives: ["logic-2"] },
      ],
      diffFiles: ["src/a.ts", "src/b.ts"],
      diffAddedLines: 42,
    };
    const result = validateFindingsJson(JSON.stringify({ ...base, coverage }));
    expect(result.valid).toBe(true);
    expect(result.parsed!.coverage).toEqual(coverage);
  });

  test.each([
    ["reviewers 非配列", { reviewers: "req-1", diffFiles: [], diffAddedLines: 0 }],
    [
      "index 非正整数",
      { reviewers: [{ index: 0, perspectives: ["req-1"] }], diffFiles: [], diffAddedLines: 0 },
    ],
    [
      "perspectives 非配列",
      { reviewers: [{ index: 1, perspectives: "req-1" }], diffFiles: [], diffAddedLines: 0 },
    ],
    ["diffFiles 非配列", { reviewers: [], diffFiles: "src/a.ts", diffAddedLines: 0 }],
    ["diffAddedLines 負数", { reviewers: [], diffFiles: [], diffAddedLines: -1 }],
    ["coverage 非オブジェクト", "coverage-string"],
  ])("不正な coverage は invalid（%s）", (_label, coverage) => {
    const result = validateFindingsJson(JSON.stringify({ ...base, coverage }));
    expect(result.valid).toBe(false);
  });
});
