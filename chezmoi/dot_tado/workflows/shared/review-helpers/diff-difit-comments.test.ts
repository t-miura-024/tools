import { describe, test, expect } from "bun:test";
import { diffDifitComments } from "./diff-difit-comments.ts";

describe("diffDifitComments", () => {
  const expected = [
    { type: "thread", filePath: "src/a.ts", position: { side: "new", line: 1 }, body: "A" },
    { type: "thread", filePath: "src/b.ts", position: { side: "new", line: 2 }, body: "B" },
  ];

  test("完全一致は match（順序差は許容）", () => {
    const result = diffDifitComments(expected, [expected[1], expected[0]]);
    expect(result.match).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  test("findings の部分集合（欠落）を missing として検出する", () => {
    const result = diffDifitComments(expected, [expected[0]]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected).toEqual([]);
  });

  test("body 改変は欠落と余剰として検出する", () => {
    const tampered = [expected[0], { ...expected[1], body: "B rewritten" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
  });

  test("配列でない actual は match=false", () => {
    const result = diffDifitComments(expected, { threads: expected });
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.invalid).toEqual([]);
  });

  test("position.side の改変（new → old）を検出する", () => {
    const tampered = [expected[0], { ...expected[1], position: { side: "old", line: 2 } }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
    expect(result.invalid).toEqual([]);
  });

  test("type の改変を検出する", () => {
    const tampered = [expected[0], { ...expected[1], type: "reply" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
  });

  test("position なしの余剰要素は読み飛ばさず invalid として fail する", () => {
    const surplus = [...expected, { type: "thread", filePath: "src/c.ts", body: "surplus" }];
    const result = diffDifitComments(expected, surplus);
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toContain("[2]");
    expect(result.invalid[0]).toContain("position");
  });

  test("配列長が同じでもキー生成不能要素があれば match=false（配列長とキー数の不一致検出）", () => {
    const tampered = [expected[0], { type: "thread", filePath: "src/b.ts", body: "B" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
  });
});
