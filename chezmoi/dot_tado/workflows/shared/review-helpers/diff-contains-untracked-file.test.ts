import { describe, test, expect } from "bun:test";
import { diffContainsUntrackedFile } from "./diff-contains-untracked-file.ts";
import { indexDiffText } from "./index-diff-text.ts";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("diffContainsUntrackedFile: +++ / diff --git / C-quote / 生パスの各形を行一致で検出する", () => {
    const textDiff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+line",
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.ts")).toBe(true);
    // 部分一致では拾わない（"src/new.ts" が "src/new.ts2" に誤ヒットしない）
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.ts2")).toBe(false);
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.tsx")).toBe(false);

    // 空・バイナリファイルは +++ 行が無く diff --git 見出しだけで現れる
    const binaryDiff = [
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(binaryDiff), "bin.dat")).toBe(true);

    // 空白入りパスは +++ 行にタブが付く
    const spaceDiff = ["diff --git a/my file.txt b/my file.txt", "+++ b/my file.txt\t"].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(spaceDiff), "my file.txt")).toBe(true);

    // 非 ASCII は C-quote された見出しを候補にする
    const quoted = quoteGitPathForDiff("日本語.txt");
    const quotedDiff = [
      `diff --git "a/${quoted}" "b/${quoted}"`,
      "--- /dev/null",
      `+++ "b/${quoted}"`,
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(quotedDiff), "日本語.txt")).toBe(true);

    // 引用符入りは C-quote + 末尾タブの形も検出する（+++ "b/my \"file\".txt"<TAB>）
    const quotePath = 'my "file".txt';
    const quoteQuoted = quoteGitPathForDiff(quotePath);
    const quoteDiff = [`+++ "b/${quoteQuoted}"\t`].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(quoteDiff), quotePath)).toBe(true);
  });
});
