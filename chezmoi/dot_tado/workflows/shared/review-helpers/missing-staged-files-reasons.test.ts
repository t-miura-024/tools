import { describe, test, expect } from "bun:test";
import { missingStagedFilesReasons } from "./missing-staged-files-reasons.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("missingStagedFilesReasons: staged の追加/変更/削除/リネームをファイル見出しで突合する", () => {
    const diff = [
      "diff --git a/src/mod.ts b/src/mod.ts",
      "--- a/src/mod.ts",
      "+++ b/src/mod.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "+x",
      "diff --git a/src/del.ts b/src/del.ts",
      "deleted file mode 100644",
      "--- a/src/del.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    expect(missingStagedFilesReasons(diff, ["src/mod.ts", "src/del.ts", "src/new.ts"])).toEqual([]);

    const reasons = missingStagedFilesReasons(diff, ["src/mod.ts", "src/staged-new.ts"]);
    expect(reasons.join("\n")).toContain("src/staged-new.ts");
    expect(reasons.join("\n")).toContain("staged");
  });
});
