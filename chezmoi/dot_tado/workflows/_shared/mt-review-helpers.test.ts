/**
 * mt-review-helpers.ts の成果物読み取り（findArtifactText / readSessionFile /
 * isPathInside）と hunk セッション生存判定（isHunkSessionLive）の自動テスト。
 * 成果物読み取りの正典は tado 本体の `src/artifacts.ts`。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findArtifactText,
  isHunkSessionLive,
  isPathInside,
  readSessionFile,
} from "./mt-review-helpers.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});

function newSessionDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mt-review-helpers-"));
  dirs.push(dir);
  return dir;
}

describe("isPathInside", () => {
  test("配下は真", () => {
    const base = newSessionDir();
    expect(isPathInside(base, path.join(base, "a", "b.txt"))).toBe(true);
  });

  test("親への脱出は偽", () => {
    const base = newSessionDir();
    expect(isPathInside(base, path.join(base, "..", "evil.txt"))).toBe(false);
  });
});

describe("readSessionFile", () => {
  test("往復できる", () => {
    const dir = newSessionDir();
    writeFileSync(path.join(dir, "memo.md"), "hello", "utf-8");
    expect(readSessionFile(dir, "memo.md")).toBe("hello");
  });

  test("未存在は undefined", () => {
    expect(readSessionFile(newSessionDir(), "missing.md")).toBeUndefined();
  });

  test("経路外は例外", () => {
    expect(() => readSessionFile(newSessionDir(), "../evil.md")).toThrow("path traversal");
  });
});

describe("findArtifactText", () => {
  test("セッション内の成果物を読める", () => {
    const dir = newSessionDir();
    const file = path.join(dir, "repo-info.json");
    writeFileSync(file, '{"owner":"o"}', "utf-8");
    const artifacts = [{ artifactKey: "repo-info.json", filePath: file }];
    expect(findArtifactText(artifacts, "repo-info.json", dir)).toBe('{"owner":"o"}');
    expect(readFileSync(file, "utf-8")).toBe('{"owner":"o"}');
  });

  test("未登録のキーは undefined", () => {
    expect(findArtifactText([], "repo-info.json", newSessionDir())).toBeUndefined();
  });

  test("セッション外の解決は例外（process.cwd() 照合の誤りを再発させない）", () => {
    const dir = newSessionDir();
    const outside = path.join(tmpdir(), "outside.txt");
    const artifacts = [{ artifactKey: "k", filePath: outside }];
    expect(() => findArtifactText(artifacts, "k", dir)).toThrow("path traversal");
  });
});

describe("isHunkSessionLive", () => {
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
    writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
    chmodSync(scriptPath, 0o755);
  }

  function fakeGit(root: string): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${root}" && exit 0
exit 1`,
    );
  }

  function fakeHunkSessionGet(stdout: string, exitCode: number): void {
    writeScript(
      "hunk",
      `printf '%s\\n' '${stdout}'
exit ${exitCode}`,
    );
  }

  test("exit 0 かつ session.sessionId があれば true", () => {
    fakeGit("/fake/repo");
    fakeHunkSessionGet('{"session":{"sessionId":"s1"}}', 0);
    expect(isHunkSessionLive()).toBe(true);
  });

  test("exit 0 でも session が null なら false", () => {
    fakeGit("/fake/repo");
    fakeHunkSessionGet('{"session":null}', 0);
    expect(isHunkSessionLive()).toBe(false);
  });

  test("exit 0 でも sessionId が文字列でなければ false", () => {
    fakeGit("/fake/repo");
    fakeHunkSessionGet('{"session":{"sessionId":123}}', 0);
    expect(isHunkSessionLive()).toBe(false);
  });

  test("exit 0 でも非 JSON なら false", () => {
    fakeGit("/fake/repo");
    fakeHunkSessionGet("no active hunk session", 0);
    expect(isHunkSessionLive()).toBe(false);
  });

  test("exit code 非 0 なら false", () => {
    fakeGit("/fake/repo");
    fakeHunkSessionGet('{"session":{"sessionId":"s1"}}', 1);
    expect(isHunkSessionLive()).toBe(false);
  });

  test("GIT_DIR 等の git 文脈を除去して git / hunk を実行する", () => {
    process.env.GIT_DIR = "/bogus/git-dir";
    try {
      // git / hunk 側に GIT_DIR が残っていれば失敗させる
      writeScript(
        "git",
        `[ -n "$GIT_DIR" ] && { echo "GIT_DIR leaked" >&2; exit 3; }
[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "/fake/repo" && exit 0
exit 1`,
      );
      writeScript(
        "hunk",
        `[ -n "$GIT_DIR" ] && { echo "GIT_DIR leaked" >&2; exit 3; }
echo '{"session":{"sessionId":"s1"}}'
exit 0`,
      );
      expect(isHunkSessionLive()).toBe(true);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
