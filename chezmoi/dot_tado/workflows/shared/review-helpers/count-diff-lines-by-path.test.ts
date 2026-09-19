import { describe, test, expect } from "bun:test";
import { countDiffLinesByPath } from "./count-diff-lines-by-path.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("countDiffLinesByPath: 追加/削除/リネーム/バイナリ/モード変更をファイル別に集計する", () => {
    const diff = [
      "diff --git a/mod.txt b/mod.txt",
      "--- a/mod.txt",
      "+++ b/mod.txt",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "-old",
      "+new",
      "+added",
      "diff --git a/del.txt b/del.txt",
      "deleted file mode 100644",
      "--- a/del.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 60%",
      "rename from old.txt",
      "rename to renamed.txt",
      "--- a/old.txt",
      "+++ b/renamed.txt",
      "@@ -1 +1,2 @@",
      " keep",
      "+more",
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
      "diff --git a/mode.sh b/mode.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const counts = countDiffLinesByPath(diff);
    expect(counts.get("mod.txt")).toEqual({ added: 2, deleted: 1 });
    expect(counts.get("del.txt")).toEqual({ added: 0, deleted: 1 });
    expect(counts.get("new.txt")).toEqual({ added: 2, deleted: 0 });
    // リネームは new 側パス（numstat の new 側パス）へ集約する
    expect(counts.get("renamed.txt")).toEqual({ added: 1, deleted: 0 });
    // バイナリ・モード変更のみのファイルは +/- 行を持たない
    expect(counts.has("bin.dat")).toBe(false);
    expect(counts.has("mode.sh")).toBe(false);
  });
});
describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("countDiffLinesByPath: hunk 内の +++ / --- 始まりの内容行をヘッダと誤認しない", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1,2 @@",
      "+++ content",
      "--- content",
    ].join("\n");
    expect(countDiffLinesByPath(diff).get("f.txt")).toEqual({ added: 1, deleted: 1 });
  });
});
