import { describe, test, expect } from "bun:test";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("quoteGitPathForDiff: git の C-quote 写像（非 ASCII・制御文字・引用符のみ）", () => {
    expect(quoteGitPathForDiff("src/plain.ts")).toBe("src/plain.ts");
    expect(quoteGitPathForDiff("src/my file.ts")).toBe("src/my file.ts");
    expect(quoteGitPathForDiff('src/quote"file.ts')).toBe('src/quote\\"file.ts');
    expect(quoteGitPathForDiff("src/tab\tfile.ts")).toBe("src/tab\\tfile.ts");
    expect(quoteGitPathForDiff("docs/日本語.md")).toBe(
      "docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md",
    );
  });
});
