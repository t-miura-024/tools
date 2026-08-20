#!/usr/bin/env bun
/**
 * get-git-diff.ts の自動テスト。
 *
 * 一時ディレクトリ（os.tmpdir + mkdtemp）に Git リポジトリを構築し、
 * `bun run get-git-diff.ts` を実行して JSON 出力・終了コードを検証する。
 * 実リポジトリ（chezmoi ソースツリー）の状態には依存しない。
 *
 * 検証ケース: 通常系（変更あり）、差分なし、ステージ済み / 未ステージ /
 * 未追跡の区別、リネーム（oldPath）、バイナリ、detached HEAD、
 * Git リポジトリ外、サブディレクトリからの実行。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "get-git-diff.ts");

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface FileChange {
  path: string;
  status: string;
  oldPath: string | null;
}

interface Stat {
  files: number;
  insertions: number | null;
  deletions: number | null;
}

interface Section {
  files: FileChange[];
  stat: Stat;
  diff: string | null;
}

interface DiffResponse {
  ok: boolean;
  hasChanges: boolean;
  error: string | null;
  staged?: Section;
  unstaged?: Section;
  untracked?: Section;
}

function exec(cmd: string, args: string[], cwd: string): ExecResult {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const git = (cwd: string, ...args: string[]): ExecResult => exec("git", args, cwd);
const runScript = (cwd: string): ExecResult => exec("bun", ["run", SCRIPT], cwd);
const parseJson = (res: ExecResult): DiffResponse => JSON.parse(res.stdout) as DiffResponse;

// --- 一時リポジトリ構築ヘルパー ---

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** `git init -b main` + ローカル user 設定でリポジトリを初期化する。 */
async function initRepo(dir: string): Promise<void> {
  expect(git(dir, "init", "-b", "main").code).toBe(0);
  expect(git(dir, "config", "user.name", "Test User").code).toBe(0);
  expect(git(dir, "config", "user.email", "test@example.com").code).toBe(0);
}

/** ファイルを書き込み、add + commit する。 */
async function commitFile(
  dir: string,
  file: string,
  content: string | Uint8Array,
  msg: string,
): Promise<void> {
  await writeFile(path.join(dir, file), content);
  expect(git(dir, "add", file).code).toBe(0);
  expect(git(dir, "commit", "-m", msg).code).toBe(0);
}

// --- テスト ---

describe("get-git-diff.ts", () => {
  test("ステージ済み / 未ステージ / 未追跡の変更を区別して返す（通常系）", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(repo, "a.txt", "alpha\n", "add a.txt");

    // ステージ済み: 追加して add する
    await writeFile(path.join(repo, "c.txt"), "charlie\n");
    expect(git(repo, "add", "c.txt").code).toBe(0);

    // 未ステージ: add せずに変更する
    await writeFile(path.join(repo, "a.txt"), "ALPHA\n");

    // 未追跡: 新規作成
    await writeFile(path.join(repo, "b.txt"), "bravo\n");

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.hasChanges).toBe(true);

    // staged
    expect(out.staged!.files).toEqual([{ path: "c.txt", status: "add", oldPath: null }]);
    expect(out.staged!.stat).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(out.staged!.diff).toContain("c.txt");

    // unstaged
    expect(out.unstaged!.files).toEqual([{ path: "a.txt", status: "modify", oldPath: null }]);
    expect(out.unstaged!.stat).toEqual({ files: 1, insertions: 1, deletions: 1 });
    expect(out.unstaged!.diff).toContain("a.txt");

    // untracked: diff と行数は null（git が提供しない）
    expect(out.untracked!.files).toEqual([{ path: "b.txt", status: "untracked", oldPath: null }]);
    expect(out.untracked!.stat).toEqual({ files: 1, insertions: null, deletions: null });
    expect(out.untracked!.diff).toBeNull();
  });

  test("差分なしのとき hasChanges: false で exit 0 を返す", async () => {
    const repo = await makeTempDir("mt-gd-clean-");
    await initRepo(repo);
    await commitFile(repo, "a.txt", "alpha\n", "add a.txt");

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toBeNull();
    expect(out.staged!.files).toEqual([]);
    expect(out.unstaged!.files).toEqual([]);
    expect(out.untracked!.files).toEqual([]);
  });

  test("ステージ済みリネームの oldPath を保持する", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(repo, "old.txt", "content\n", "add old.txt");

    expect(git(repo, "mv", "old.txt", "new.txt").code).toBe(0);

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.hasChanges).toBe(true);
    expect(out.staged!.files).toHaveLength(1);
    expect(out.staged!.files[0]).toEqual({ path: "new.txt", status: "rename", oldPath: "old.txt" });
  });

  test("未ステージのリネームは delete + untracked として返す（git の実挙動）", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(repo, "old.txt", "content\n", "add old.txt");

    // mv するだけでステージしない場合、new.txt は未追跡のため
    // git diff の rename 検出対象にならず、delete と untracked に分かれる
    await rename(path.join(repo, "old.txt"), path.join(repo, "new.txt"));

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.unstaged!.files).toEqual([{ path: "old.txt", status: "delete", oldPath: null }]);
    expect(out.untracked!.files).toEqual([{ path: "new.txt", status: "untracked", oldPath: null }]);
  });

  test("バイナリ変更を処理し、行数はカウントしない", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(
      repo,
      "bin.dat",
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]),
      "add binary",
    );

    // 未ステージのバイナリ変更
    await writeFile(path.join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0xff, 0x00, 0x12, 0x34]));

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    const byPath = Object.fromEntries((out.unstaged!.files ?? []).map((f) => [f.path, f]));
    expect(byPath["bin.dat"]).toEqual({ path: "bin.dat", status: "modify", oldPath: null });
    // バイナリは numstat が '-' になるため行数に数えない
    expect(out.unstaged!.stat).toEqual({ files: 1, insertions: 0, deletions: 0 });
    expect(out.unstaged!.diff).toContain("Binary files");
  });

  test("detached HEAD でも作業ツリー差分を取得できる", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(repo, "a.txt", "alpha\n", "add a.txt");

    // コミットハッシュを直接指定して detached HEAD にする
    const sha = git(repo, "rev-parse", "HEAD").stdout.trim();
    expect(git(repo, "checkout", sha).code).toBe(0);
    expect(git(repo, "symbolic-ref", "-q", "HEAD").code).not.toBe(0); // detached 確認

    await writeFile(path.join(repo, "e.txt"), "echo\n");

    const res = runScript(repo);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.untracked!.files).toEqual([{ path: "e.txt", status: "untracked", oldPath: null }]);
  });

  test("Git リポジトリ外ではエラー JSON + 非ゼロ終了", async () => {
    const dir = await makeTempDir("mt-gd-norepo-"); // git init しない

    const res = runScript(dir);
    expect(res.code).not.toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(false);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toContain("リポジトリ");
  });

  test("リポジトリのサブディレクトリを cwd にして実行しても通常どおり差分を返す", async () => {
    const repo = await makeTempDir("mt-gd-repo-");
    await initRepo(repo);
    await commitFile(repo, "a.txt", "alpha\n", "add a.txt");

    // 未ステージの変更と未追跡ファイルを作る
    await writeFile(path.join(repo, "a.txt"), "ALPHA\n");
    await writeFile(path.join(repo, "b.txt"), "bravo\n");

    // リポジトリルート配下のサブディレクトリを cwd にして実行する
    const subdir = path.join(repo, "src");
    await mkdir(subdir);

    const res = runScript(subdir);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.error).toBeNull();
    expect(out.staged!.files).toEqual([]);
    expect(out.unstaged!.files).toEqual([{ path: "a.txt", status: "modify", oldPath: null }]);
    expect(out.untracked!.files).toEqual([{ path: "b.txt", status: "untracked", oldPath: null }]);
  });
});
