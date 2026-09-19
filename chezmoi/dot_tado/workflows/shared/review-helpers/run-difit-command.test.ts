import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { DIFIT_MAX_BUFFER_BYTES } from "./difit-max-buffer-bytes.ts";
import { fetchDifitThreads } from "./fetch-difit-threads.ts";
import { isDifitOutputTooLargeError } from "./is-difit-output-too-large-error.ts";
import { isDifitSpawnError } from "./is-difit-spawn-error.ts";
import { isDifitTimeoutError } from "./is-difit-timeout-error.ts";
import { runDifitCommand } from "./run-difit-command.ts";

describe("runDifitCommand (stderr / maxBuffer)", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = newSessionDir();
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  test("exit 1 でも stdout / stderr を捨てずに回収する（ゲートブロック + 警告の両取り）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
printf '%s\\n' '{"passes":false,"blocking_threads":[]}'
printf '%s\\n' 'mt difit: 警告: ブラウザの diff 選択が起動時と異なります' >&2
exit 1`,
    );

    const result = runDifitCommand(["check", "--dry-run"]);

    expect(result.stdout).toContain('"passes":false');
    expect(result.stderr).toContain("ブラウザの diff 選択が起動時と異なります");
  });

  test("spawn 失敗（mt 不在）は DifitSpawnError で原因（ENOENT 等）を報告する（空出力に縮退させない）", () => {
    process.env.PATH = binDir; // mt / git など何も置かない
    let caught: unknown;
    try {
      runDifitCommand(["threads", "--json"]);
    } catch (error) {
      caught = error;
    }
    expect(isDifitSpawnError(caught)).toBe(true);
    expect((caught as Error).message).toContain("mt difit threads --json");
    expect((caught as Error).message).toContain("spawn 失敗");
    expect((caught as Error).message).toContain("ENOENT");
  });

  test("既定 1 MiB を超える threads 出力（2 MiB body）でも切り詰めずに取得できる", () => {
    const bodyBytes = 2 * 1024 * 1024;
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
BODY=$(head -c ${bodyBytes} /dev/zero | tr '\\0' 'a')
printf '{"passes":true,"blocking_threads":[],"threads":[{"id":"t1","filePath":"src/a.ts","position":{"side":"new","line":1},"taxonomy":"issue","blocking":false,"body":"%s","author":null,"replies":[]}]}\\n' "$BODY"
exit 0`,
    );

    const result = fetchDifitThreads();

    expect(result.output).toBeDefined();
    expect(result.output!.threads[0].body.length).toBeGreaterThanOrEqual(bodyBytes);
  });

  test("maxBuffer 超過は DifitOutputTooLargeError で原因を報告する（切り詰め断片を返さない）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
head -c ${DIFIT_MAX_BUFFER_BYTES + 1024} /dev/zero | tr '\\0' 'a'
exit 0`,
    );

    let caught: unknown;
    try {
      fetchDifitThreads();
    } catch (error) {
      caught = error;
    }
    expect(isDifitOutputTooLargeError(caught)).toBe(true);
    expect((caught as Error).message).toContain("maxBuffer");
  });

  test("timeout 以内に応答しない mt は DifitTimeoutError で理由を報告する（同期実行を無制限にブロックしない）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
sleep 5
printf '%s\\n' '{"passes":true,"blocking_threads":[]}'
exit 0`,
    );

    let caught: unknown;
    const startedAt = Date.now();
    try {
      runDifitCommand(["done"], 200);
    } catch (error) {
      caught = error;
    }
    expect(isDifitTimeoutError(caught)).toBe(true);
    expect((caught as Error).message).toContain("timeout");
    // timeout を待たずに kill されて戻る（テストは数秒で完了する）
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
