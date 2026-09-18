import { describe, test, expect } from "bun:test";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";
import { unquoteGitPath } from "./unquote-git-path.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("unquoteGitPath: quoteGitPathForDiff の逆写像（非 ASCII・escape、非引用は原文）", () => {
    expect(unquoteGitPath('"docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"')).toBe(
      "docs/日本語.md",
    );
    expect(unquoteGitPath('"my \\"file\\".txt"')).toBe('my "file".txt');
    expect(unquoteGitPath('"tab\\tfile.txt"')).toBe("tab\tfile.txt");
    expect(unquoteGitPath("plain/path.ts")).toBe("plain/path.ts");
    // 壊れた入力でも例外にせず原文を返す（無音クラッシュしない）
    expect(unquoteGitPath('"unterminated')).toBe('"unterminated');
    // 往復で一致する（git の `+++ "b/<quoted>"` と同じく全体を引用符で囲む）
    for (const path of [
      "src/plain.ts",
      "my file.txt",
      'quote"file.txt',
      "tab\tfile.txt",
      "docs/日本語.md",
    ]) {
      const quoted = quoteGitPathForDiff(path);
      if (quoted !== path) {
        expect(unquoteGitPath(`"${quoted}"`)).toBe(path);
      }
    }
  });
});
