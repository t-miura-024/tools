import { describe, test, expect } from "bun:test";
import { diffContainsPath } from "./diff-contains-path.ts";
import { indexDiffText } from "./index-diff-text.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("diffContainsPath: 削除（--- a/…）とリネーム（rename to …）の見出し形も検出する", () => {
    const deletion = ["diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null"].join(
      "\n",
    );
    expect(diffContainsPath(indexDiffText(deletion), "gone.txt")).toBe(true);

    const rename = [
      "diff --git a/old.txt b/new.txt",
      "rename from old.txt",
      "rename to new.txt",
    ].join("\n");
    expect(diffContainsPath(indexDiffText(rename), "new.txt")).toBe(true);
    expect(diffContainsPath(indexDiffText(rename), "old.txt")).toBe(true);
    expect(diffContainsPath(indexDiffText(rename), "other.txt")).toBe(false);
  });
});
