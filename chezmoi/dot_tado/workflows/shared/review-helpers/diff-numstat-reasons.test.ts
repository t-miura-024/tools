import { describe, test, expect } from "bun:test";
import { diffNumstatReasons } from "./diff-numstat-reasons.ts";
import type { DiffNumstatEntry } from "./types.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("diffNumstatReasons: 一致は空、ファイル欠落・行数不一致・バイナリ見出し欠落を検出する", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "+added",
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
    ].join("\n");
    const entries: DiffNumstatEntry[] = [
      { path: "src/a.ts", added: 1, deleted: 0 },
      { path: "bin.dat", added: null, deleted: null },
    ];
    expect(diffNumstatReasons(diff, entries)).toEqual([]);

    const missing = diffNumstatReasons(diff, [
      ...entries,
      { path: "src/dropped.ts", added: 1, deleted: 0 },
    ]);
    expect(missing.join("\n")).toContain("src/dropped.ts");
    expect(missing.join("\n")).toContain("欠落");

    const mismatched = diffNumstatReasons(diff, [{ path: "src/a.ts", added: 5, deleted: 0 }]);
    expect(mismatched.join("\n")).toContain("一致しません");
    expect(mismatched.join("\n")).toContain("+5/-0");

    // バイナリは行数を持たないが、ファイル見出しの出現だけは検証する
    const withoutBinary = diff
      .split("\n")
      .filter((line) => !line.startsWith("diff --git a/bin.dat"))
      .join("\n");
    expect(diffNumstatReasons(withoutBinary, entries).join("\n")).toContain("bin.dat");
  });
});
