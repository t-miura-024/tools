import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { listStagedFiles } from "./list-staged-files.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("listStagedFiles: staged のみを返し、リネームの元パスと未追跡を読み飛ばす", () => {
    const binDir = newSessionDir();
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const scriptPath = path.join(binDir, "git");
      // porcelain v1 -z: `XY <path>\0[<orig>\0]`。X が空白/`?` の作業ツリー変更は staged ではない。
      writeFileSync(
        `${scriptPath}.body`,
        `#!/bin/sh
printf 'M  src/mod.ts\\0A  src/new.ts\\0?? src/untracked.ts\\0 M src/unstaged.ts\\0R  src/renamed.ts\\0src/old.ts\\0'
`,
      );
      rmSync(scriptPath, { force: true });
      symlinkSync(ensureFakeScriptRunner(), scriptPath);

      const result = listStagedFiles();
      expect("files" in result).toBe(true);
      expect("files" in result ? result.files : []).toEqual([
        "src/mod.ts",
        "src/new.ts",
        "src/renamed.ts",
      ]);

      // 失敗時は空一覧へ縮退せず error を返す
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nexit 128\n`);
      const failed = listStagedFiles();
      expect("error" in failed).toBe(true);
      expect("error" in failed ? failed.error : "").toContain("status");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
