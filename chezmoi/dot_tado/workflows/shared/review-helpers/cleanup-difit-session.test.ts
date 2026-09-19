import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { cleanupDifitSession } from "./cleanup-difit-session.ts";

describe("cleanupDifitSession (done + state 消失 + pid 終了の検証)", () => {
  let binDir: string;
  let repoRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = newSessionDir();
    repoRoot = path.join(binDir, "repo");
    mkdirSync(path.join(repoRoot, ".difit"), { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  function fakeGit(): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${repoRoot}" && exit 0
exit 1`,
    );
  }

  function writeState(pid: number): void {
    writeFileSync(
      path.join(repoRoot, ".difit", "difit-review.json"),
      JSON.stringify({ port: 4966, pid, comments: [], difit_args: [], tab: null }),
    );
  }

  function fakeMtDone(options: { removeState?: boolean; json?: string } = {}): void {
    const lines = [`[ "$1" = "difit" ] || exit 64`, `[ "$2" = "done" ] || exit 64`];
    if (options.removeState ?? true) {
      lines.push(`rm -f "${repoRoot}/.difit/difit-review.json"`);
    }
    lines.push(
      `printf '%s\\n' '${options.json ?? '{"passes":true,"blocking_threads":[]}'}'`,
      "exit 0",
    );
    writeScript("mt", lines.join("\n"));
  }

  test("done が state を削除し、done 前 pid が終了していれば pass（done 出力と stderr を返す）", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone();
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("pass");
    expect(cleanup.done?.passes).toBe(true);
    expect(cleanup.reasons.join("\n")).toContain("pid=2147483647");
    expect(existsSync(path.join(repoRoot, ".difit", "difit-review.json"))).toBe(false);
  });

  test("done 後も difit プロセスが生存していれば error（orphan 検出）", () => {
    fakeGit();
    writeState(process.pid);
    fakeMtDone();
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("生存");
  });

  test("done 後も state が残っていれば error", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone({ removeState: false });
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("残っています");
  });

  test("done が契約出力を返さなければ error（後始末を検証できない）", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone({ json: "not json" });
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("後始末出力");
  });

  test("done の spawn 失敗（mt 不在）は DifitSpawnError の理由で error を返す（原因を消さない）", () => {
    fakeGit();
    writeState(2147483647);
    process.env.PATH = binDir; // mt を PATH から外す（git fake のみ残す）
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("spawn 失敗");
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
