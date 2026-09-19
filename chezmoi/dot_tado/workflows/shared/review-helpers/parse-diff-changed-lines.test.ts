import { describe, test, expect } from "bun:test";
import { parseDiffChangedLines } from "./parse-diff-changed-lines.ts";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("parseDiffChangedLines: C-quote された +++ パスを生の filePath へ逆写像する（非 ASCII 回帰）", () => {
    const quotedPath = quoteGitPathForDiff("docs/日本語.md");
    const diff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      `--- "a/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -0,0 +1,2 @@",
      "+追加行1",
      "+追加行2",
    ].join("\n");
    const map = parseDiffChangedLines(diff);
    // レビュアーは生の filePath（docs/日本語.md）を返すため、キーを生パスに統一する
    expect([...map.keys()]).toEqual(["docs/日本語.md"]);
    expect([...map.get("docs/日本語.md")!]).toEqual([1, 2]);

    // core.quotePath=false の生パス形（空白 + 末尾タブ）も同じキーへ正規化する
    const rawDiff = [
      "diff --git a/my file.txt b/my file.txt",
      "--- a/my file.txt\t",
      "+++ b/my file.txt\t",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    expect([...parseDiffChangedLines(rawDiff).keys()]).toEqual(["my file.txt"]);

    // 引用符入りパス（core.quotePath=false でも \" escape で引用される）の回帰
    const quoteDiff = [
      'diff --git "a/my \\"file\\".txt" "b/my \\"file\\".txt"',
      '+++ "b/my \\"file\\".txt"\t',
      "@@ -0,0 +1 @@",
      "+y",
    ].join("\n");
    expect([...parseDiffChangedLines(quoteDiff).keys()]).toEqual(['my "file".txt']);
  });
});
