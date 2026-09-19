import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { listUntrackedFiles } from "./list-untracked-files.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("listUntrackedFiles: -z の NUL 区切りを分解し、失敗は理由付きで返す", () => {
    const binDir = newSessionDir();
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const scriptPath = path.join(binDir, "git");
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nprintf 'a.ts\\0dir/b b.ts\\0'\n`);
      rmSync(scriptPath, { force: true });
      symlinkSync(ensureFakeScriptRunner(), scriptPath);

      const result = listUntrackedFiles();
      expect("files" in result).toBe(true);
      expect("files" in result ? result.files : []).toEqual(["a.ts", "dir/b b.ts"]);

      // 失敗時は空一覧へ縮退せず error を返す
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nexit 128\n`);
      const failed = listUntrackedFiles();
      expect("error" in failed).toBe(true);
      expect("error" in failed ? failed.error : "").toContain("ls-files");
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
