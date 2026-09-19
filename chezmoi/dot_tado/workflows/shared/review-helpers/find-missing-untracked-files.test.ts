import { describe, test, expect } from "bun:test";
import { diffCompletenessReasons } from "./diff-completeness-reasons.ts";
import { findMissingUntrackedFiles } from "./find-missing-untracked-files.ts";
import { indexDiffText } from "./index-diff-text.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("findMissingUntrackedFiles / diffCompletenessReasons: 欠落とマーカーを検出する", () => {
    const diff = ["diff --git a/kept.ts b/kept.ts", "+++ b/kept.ts", "@@ -0,0 +1 @@", "+x"].join(
      "\n",
    );
    expect(findMissingUntrackedFiles(indexDiffText(diff), ["kept.ts"])).toEqual([]);
    expect(findMissingUntrackedFiles(indexDiffText(diff), ["kept.ts", "dropped.ts"])).toEqual([
      "dropped.ts",
    ]);

    expect(diffCompletenessReasons(diff, ["kept.ts"])).toEqual([]);

    const marker = `${diff}\n[... truncated: 5000 lines omitted]\n`;
    const markerReasons = diffCompletenessReasons(marker, ["kept.ts"]);
    expect(markerReasons.join("\n")).toContain("truncate マーカー");

    // 差分本文の `+ [... truncated...`（行頭が +）はマーカーではない
    const content = `${diff}\n+[... truncated: 3 lines omitted]`;
    expect(diffCompletenessReasons(content, ["kept.ts"])).toEqual([]);

    const missingReasons = diffCompletenessReasons(diff, ["kept.ts", "dropped.ts"]);
    expect(missingReasons.join("\n")).toContain("dropped.ts");
    expect(missingReasons.join("\n")).toContain("1 件欠落");
  });
});
