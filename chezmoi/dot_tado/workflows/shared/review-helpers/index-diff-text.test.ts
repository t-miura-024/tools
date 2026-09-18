import { describe, test, expect } from "bun:test";
import { indexDiffText } from "./index-diff-text.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("indexDiffText: 行配列と行 Set を 1 回の split で共有する（マーカー検査と untracked 突合で同一結果）", () => {
    const index = indexDiffText("a\nb\na");
    expect(index.lines).toEqual(["a", "b", "a"]);
    expect(index.lineSet.has("a")).toBe(true);
    expect(index.lineSet.has("c")).toBe(false);
    // 重複行は Set で 1 件に畳まれるが、行配列（マーカー走査用）は元の行数・順序を保つ
    expect(index.lineSet.size).toBe(2);
    expect(index.lines.length).toBe(3);
  });
});
