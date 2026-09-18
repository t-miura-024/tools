import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { fetchDifitThreads } from "./fetch-difit-threads.ts";

describe("fetchDifitThreads (選択固定・read-only)", () => {
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

  /// `mt difit threads --json` 以外の引数では exit 64 にして退行を検出する。
  function fakeMtThreads(output: string, exitCode = 0): void {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${output}'
exit ${exitCode}`,
    );
  }

  /// stderr へ診断メッセージを出す fake mt（選択ドリフト警告・同一性照合エラーの回収テスト用）。
  function fakeMtThreadsWithStderr(output: string, exitCode: number, stderr: string): void {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${output}'
printf '%s\\n' '${stderr}' >&2
exit ${exitCode}`,
    );
  }

  test("mt difit threads --json の契約をパースして返す（blocking_threads は check と同形）", () => {
    const thread = {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 12 },
      taxonomy: "issue",
      blocking: true,
      body: "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\nbody",
      author: null,
      replies: [{ author: "User", body: "human reply" }],
    };
    const blocking = {
      id: "t1",
      file: "src/a.ts",
      line: 12,
      taxonomy: "issue",
      body: thread.body,
      replies: ["human reply"],
    };
    fakeMtThreads(
      JSON.stringify({
        passes: false,
        selection: { base: "aaa", target: "bbb" },
        threads: [thread],
        blocking_threads: [blocking],
      }),
    );

    const result = fetchDifitThreads();

    expect(result.output).toBeDefined();
    expect(result.output!.passes).toBe(false);
    expect(result.output!.blocking_threads).toEqual([blocking]);
    expect(result.output!.threads).toHaveLength(1);
    expect(result.output!.threads[0]).toMatchObject({
      id: "t1",
      filePath: "src/a.ts",
      taxonomy: "issue",
      blocking: true,
      body: thread.body,
      replies: [{ author: "User", body: "human reply" }],
    });
  });

  test("コマンド失敗（セッション不在・選択未記録・サーバ死）は output undefined（無音 pass しない）", () => {
    fakeMtThreads("", 1);
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("threads 配列が無い出力は output undefined（契約違反）", () => {
    fakeMtThreads(JSON.stringify({ passes: true, blocking_threads: [] }));
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("threads 要素の契約違反（replies 欠落）は output undefined", () => {
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [
          { id: "t1", filePath: "src/a.ts", taxonomy: "issue", blocking: false, body: "b" },
        ],
        blocking_threads: [],
      }),
    );
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("stderr を成功時も失敗時も回収する（選択ドリフト警告・同一性照合エラーを捨てない）", () => {
    fakeMtThreadsWithStderr(
      JSON.stringify({ passes: true, threads: [], blocking_threads: [] }),
      0,
      "mt difit: 警告: ブラウザの diff 選択が起動時と異なります",
    );
    const okResult = fetchDifitThreads();
    expect(okResult.output).toBeDefined();
    expect(okResult.stderr).toContain("ブラウザの diff 選択が起動時と異なります");

    fakeMtThreadsWithStderr("", 1, "mt difit: 記録された pid が記録 port を LISTEN していません");
    const failed = fetchDifitThreads();
    expect(failed.output).toBeUndefined();
    expect(failed.stderr).toContain("LISTEN していません");
  });

  test("threads --json の selection_drift（detection / expected / current）を型ガードで取り込む", () => {
    const thread = {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 1 },
      taxonomy: "issue",
      blocking: true,
      body: "body",
      author: null,
      replies: [],
    };
    fakeMtThreads(
      JSON.stringify({
        passes: false,
        threads: [thread],
        blocking_threads: [],
        selection_drift: {
          detection: "detected",
          expected: { base: "aaa", target: "bbb", baseMode: "merge-base" },
          current: { base: "ccc", target: "ddd" },
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "detected",
      expected: { base: "aaa", target: "bbb", baseMode: "merge-base" },
      current: { base: "ccc", target: "ddd" },
    });

    // probe 失敗時は current が null（検知不能）
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: {
          detection: "unavailable",
          expected: { base: "aaa", target: "bbb" },
          current: null,
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "unavailable",
      expected: { base: "aaa", target: "bbb" },
    });

    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: {
          detection: "none",
          expected: { base: "aaa", target: "bbb" },
          current: { base: "aaa", target: "bbb" },
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "none",
      expected: { base: "aaa", target: "bbb" },
      current: { base: "aaa", target: "bbb" },
    });
  });

  test("旧形式（boolean / {detected}）の selection_drift は解釈せず undefined（新スキーマのみ受理）", () => {
    fakeMtThreads(
      JSON.stringify({ passes: true, threads: [], blocking_threads: [], selection_drift: false }),
    );
    const fromBoolean = fetchDifitThreads();
    expect(fromBoolean.output!.selection_drift).toBeUndefined();
    // フィールドは存在するが解釈できない = 契約違反マーカーを立てる（無音でドリフトなしにしない）
    expect(fromBoolean.output!.selection_drift_error).toContain("オブジェクト");

    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: { detected: true, expected: { base: "aaa", target: "bbb" } },
      }),
    );
    const fromLegacy = fetchDifitThreads();
    expect(fromLegacy.output!.selection_drift).toBeUndefined();
    expect(fromLegacy.output!.selection_drift_error).toContain("detection");
  });

  test("selection_drift の未知の detection は selection_drift_error に理由を記録する", () => {
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: { detection: "drifted" },
      }),
    );
    const result = fetchDifitThreads();
    expect(result.output!.selection_drift).toBeUndefined();
    expect(result.output!.selection_drift_error).toContain("drifted");
  });

  test("selection_drift の欠落は error マーカーを立てない（done など drift を省く経路を区別する）", () => {
    fakeMtThreads(JSON.stringify({ passes: true, threads: [], blocking_threads: [] }));
    const result = fetchDifitThreads();
    expect(result.output!.selection_drift).toBeUndefined();
    expect(result.output!.selection_drift_error).toBeUndefined();
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
