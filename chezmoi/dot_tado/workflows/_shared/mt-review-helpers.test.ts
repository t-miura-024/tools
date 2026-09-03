/**
 * mt-review-helpers.ts の成果物読み取り（findArtifactText / readSessionFile /
 * isPathInside）の自動テスト。正典は tado 本体の `src/artifacts.ts`。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findArtifactText, isPathInside, readSessionFile } from "./mt-review-helpers.ts";

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
