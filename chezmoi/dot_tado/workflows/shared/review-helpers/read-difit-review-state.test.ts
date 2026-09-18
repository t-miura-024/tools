import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirs, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { readDifitReviewState } from "./read-difit-review-state.ts";

describe("readDifitReviewState (fail-closed state 読み取り)", () => {
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
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  function fakeGit(root: string): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${root}" && exit 0
exit 1`,
    );
  }

  function statePath(): string {
    return path.join(repoRoot, ".difit", "difit-review.json");
  }

  function writeDifitState(state: Record<string, unknown> | string): void {
    const body = typeof state === "string" ? state : JSON.stringify(state);
    writeFileSync(statePath(), body);
  }

  test("port / pid / selection を読み取り、selection は任意（旧 state では undefined）", () => {
    fakeGit(repoRoot);
    writeDifitState({
      port: 4966,
      pid: process.pid,
      selection: { base: "abc1234", target: ".", baseMode: "merge-base" },
    });
    expect(readDifitReviewState()).toEqual({
      state: {
        port: 4966,
        pid: process.pid,
        selection: { base: "abc1234", target: ".", baseMode: "merge-base" },
      },
    });

    writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
    expect(readDifitReviewState()).toEqual({ state: { port: 4966, pid: process.pid } });
  });

  test("状態ファイルが無ければ missing（不在と読み取り不能を区別する）", () => {
    fakeGit(repoRoot);
    expect(readDifitReviewState()).toEqual({ missing: true });
  });

  test(".difit が symlink なら error（リンク先の state を読まない fail-closed）", () => {
    fakeGit(repoRoot);
    const target = path.join(binDir, "linked-difit");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "difit-review.json"),
      JSON.stringify({ port: 4966, pid: process.pid }),
    );
    rmSync(path.join(repoRoot, ".difit"), { recursive: true, force: true });
    symlinkSync(target, path.join(repoRoot, ".difit"));

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("symlink");
  });

  test("state ファイルが symlink なら error（リンク先を state として読まない fail-closed）", () => {
    fakeGit(repoRoot);
    const linked = path.join(binDir, "linked-state.json");
    writeFileSync(linked, JSON.stringify({ port: 4966, pid: process.pid }));
    symlinkSync(linked, statePath());

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("symlink");
  });

  test("port が不正なら error", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 0, pid: process.pid, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("port");
  });

  test("pid が不正（<= 0）なら error", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 4966, pid: -1, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("pid");
  });

  test("selection が不正なら error（選択固定キーの契約違反）", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 4966, pid: process.pid, selection: {} });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("selection");
  });

  test("JSON が不正なら error", () => {
    fakeGit(repoRoot);
    writeDifitState("not json");
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("JSON オブジェクト");
  });

  test("git rev-parse が失敗すれば error（不在と同一視しない）", () => {
    writeScript("git", "exit 1");
    writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("git");
  });

  test("GIT_DIR 等の git 文脈を除去して git を実行する", () => {
    process.env.GIT_DIR = "/bogus/git-dir";
    try {
      // git 側に GIT_DIR が残っていれば失敗させる
      writeScript(
        "git",
        `[ -n "$GIT_DIR" ] && { echo "GIT_DIR leaked" >&2; exit 3; }
[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${repoRoot}" && exit 0
exit 1`,
      );
      writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
      expect(readDifitReviewState()).toEqual({ state: { port: 4966, pid: process.pid } });
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  test("state が通常ファイルでない（ディレクトリ化）なら error", () => {
    fakeGit(repoRoot);
    rmSync(statePath(), { force: true });
    mkdirSync(statePath(), { recursive: true });

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("difit-review.json");
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
