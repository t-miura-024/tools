#!/usr/bin/env bun
/**
 * get-branch-diff.ts の自動テスト。
 *
 * 一時ディレクトリ（os.tmpdir + mkdtemp）に Git リポジトリを構築し、
 * `bun run get-branch-diff.ts` を実行して JSON 出力・終了コードを検証する。
 * 実リポジトリ（chezmoi ソースツリー）の状態には依存しない。
 *
 * 検証ケース: 通常系（変更あり）、引数指定（<base> / <base>..<head>）、
 * 差分なし、リネーム（oldPath）、バイナリ、リモート未設定、
 * origin/HEAD 未設定、detached HEAD、Git リポジトリ外、サブディレクトリからの実行。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dir, 'get-branch-diff.ts');

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

interface DiffResponse {
  ok: boolean;
  hasChanges: boolean;
  error: string | null;
  baseBranch?: string;
  mergeBase?: string;
  files?: FileChange[];
  stat?: { files: number; insertions: number; deletions: number };
  rawDiff?: string;
}

function exec(cmd: string, args: string[], cwd: string): ExecResult {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const git = (cwd: string, ...args: string[]): ExecResult => exec('git', args, cwd);
const runScript = (cwd: string, ...args: string[]): ExecResult => exec('bun', ['run', SCRIPT, ...args], cwd);
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
  expect(git(dir, 'init', '-b', 'main').code).toBe(0);
  expect(git(dir, 'config', 'user.name', 'Test User').code).toBe(0);
  expect(git(dir, 'config', 'user.email', 'test@example.com').code).toBe(0);
}

/** ファイルを書き込み、add + commit する。 */
async function commitFile(dir: string, file: string, content: string | Uint8Array, msg: string): Promise<void> {
  await writeFile(path.join(dir, file), content);
  expect(git(dir, 'add', file).code).toBe(0);
  expect(git(dir, 'commit', '-m', msg).code).toBe(0);
}

/**
 * upstream を origin として clone する。clone は通常 origin/HEAD を設定するが、
 * 環境によっては設定されないため、未設定なら `remote set-head --auto` で補う。
 */
async function cloneFrom(upstream: string, work: string): Promise<void> {
  expect(git(work, 'clone', upstream, work).code).toBe(0);
  const head = git(work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD');
  if (head.code !== 0) {
    expect(git(work, 'remote', 'set-head', 'origin', '--auto').code).toBe(0);
    expect(git(work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD').code).toBe(0);
  }
}

// --- テスト ---

describe('get-branch-diff.ts', () => {
  test('変更ありのブランチ差分を origin/HEAD 基準で取得できる（通常系）', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');
    await commitFile(upstream, 'b.txt', 'bravo\n', 'add b.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    // 変更 + 追加をコミットする
    await writeFile(path.join(work, 'a.txt'), 'ALPHA\n');
    await writeFile(path.join(work, 'c.txt'), 'charlie\n');
    expect(git(work, 'add', 'a.txt', 'c.txt').code).toBe(0);
    expect(git(work, 'commit', '-m', 'modify a, add c').code).toBe(0);

    const res = runScript(work);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.error).toBeNull();
    expect(out.baseBranch).toBe('origin/main');
    expect(out.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(out.mergeBase).toBe(git(work, 'rev-parse', 'origin/main').stdout.trim());

    const byPath = Object.fromEntries((out.files ?? []).map((f) => [f.path, f]));
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', status: 'modify', oldPath: null });
    expect(byPath['c.txt']).toEqual({ path: 'c.txt', status: 'add', oldPath: null });
    expect(out.stat).toEqual({ files: 2, insertions: 2, deletions: 1 });
    expect(out.rawDiff).toContain('diff --git');
    expect(out.rawDiff).toContain('a.txt');
  });

  test('引数 <base> で明示的にベースを指定できる', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    await commitFile(work, 'b.txt', 'bravo\n', 'add b.txt');

    const res = runScript(work, 'origin/main');
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.baseBranch).toBe('origin/main');
    expect(out.files).toEqual([{ path: 'b.txt', status: 'add', oldPath: null }]);
  });

  test('引数 <base>..<head> 形式で指定できる', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    await commitFile(work, 'b.txt', 'bravo\n', 'add b.txt');
    await commitFile(work, 'c.txt', 'charlie\n', 'add c.txt');

    // 1 つ目のコミット（b.txt）と HEAD（c.txt）の差分
    const first = git(work, 'rev-parse', 'HEAD~1').stdout.trim();
    const res = runScript(work, `${first}..HEAD`);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.baseBranch).toBe(first);
    expect(out.files).toEqual([{ path: 'c.txt', status: 'add', oldPath: null }]);
  });

  test('差分なしのとき hasChanges: false で exit 0 を返す', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    const res = runScript(work);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toBeNull();
    expect(out.files).toEqual([]);
    expect(out.stat).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(out.rawDiff).toBe('');
  });

  test('リネームの oldPath を保持する', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    expect(git(work, 'mv', 'a.txt', 'renamed.txt').code).toBe(0);
    expect(git(work, 'commit', '-m', 'rename a.txt').code).toBe(0);

    const res = runScript(work);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.files).toHaveLength(1);
    expect(out.files![0]).toEqual({ path: 'renamed.txt', status: 'rename', oldPath: 'a.txt' });
    expect(out.stat).toEqual({ files: 1, insertions: 0, deletions: 0 });
  });

  test('バイナリ変更を処理し、行数はカウントしない', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]), 'add binary');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    await commitFile(work, 'bin.dat', Buffer.from([0x00, 0x01, 0xff, 0x00, 0x12, 0x34]), 'modify binary');

    const res = runScript(work);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    const byPath = Object.fromEntries((out.files ?? []).map((f) => [f.path, f]));
    expect(byPath['bin.dat']).toEqual({ path: 'bin.dat', status: 'modify', oldPath: null });
    // バイナリは numstat が '-' になるため行数に数えない
    expect(out.stat).toEqual({ files: 1, insertions: 0, deletions: 0 });
    expect(out.rawDiff).toContain('Binary files');
  });

  test('origin（リモート）未設定ではエラー JSON + 非ゼロ終了', async () => {
    const repo = await makeTempDir('mt-bd-noremote-');
    await initRepo(repo);
    await commitFile(repo, 'a.txt', 'alpha\n', 'add a.txt');

    const res = runScript(repo);
    expect(res.code).not.toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(false);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toContain('origin/HEAD');
  });

  test('origin/HEAD 未設定ではエラー JSON + 非ゼロ終了', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    // origin/HEAD を明示的に削除して未設定状態を作る
    expect(git(work, 'remote', 'set-head', 'origin', '-d').code).toBe(0);
    expect(git(work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD').code).not.toBe(0);

    const res = runScript(work);
    expect(res.code).not.toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(false);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toContain('origin/HEAD が未設定');
  });

  test('detached HEAD でも差分を取得できる', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    // ブランチの先頭コミット（origin/main と同一）を直接指定して detached HEAD にする
    const head = git(work, 'rev-parse', 'HEAD').stdout.trim();
    expect(git(work, 'checkout', head).code).toBe(0);
    expect(git(work, 'symbolic-ref', '-q', 'HEAD').code).not.toBe(0); // detached 確認

    // detached HEAD 上で変更をコミットする（ブランチには載らない）
    await commitFile(work, 'd.txt', 'delta\n', 'add d.txt on detached HEAD');

    const res = runScript(work);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.files).toEqual([{ path: 'd.txt', status: 'add', oldPath: null }]);
  });

  test('Git リポジトリ外ではエラー JSON + 非ゼロ終了', async () => {
    const dir = await makeTempDir('mt-bd-norepo-'); // git init しない

    const res = runScript(dir);
    expect(res.code).not.toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(false);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toContain('リポジトリ');
  });

  test('存在しないベースを指定するとエラー JSON + 非ゼロ終了', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    const res = runScript(work, 'no-such-branch');
    expect(res.code).not.toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(false);
    expect(out.hasChanges).toBe(false);
    expect(out.error).toContain('base を解決できません');
  });

  test('リポジトリのサブディレクトリを cwd にして実行しても通常どおり差分を返す', async () => {
    const upstream = await makeTempDir('mt-bd-upstream-');
    await initRepo(upstream);
    await commitFile(upstream, 'a.txt', 'alpha\n', 'add a.txt');

    const work = await makeTempDir('mt-bd-work-');
    await cloneFrom(upstream, work);

    await commitFile(work, 'c.txt', 'charlie\n', 'add c.txt');

    // リポジトリルート配下のサブディレクトリを cwd にして実行する
    const subdir = path.join(work, 'src');
    await mkdir(subdir);

    const res = runScript(subdir);
    expect(res.code).toBe(0);
    const out = parseJson(res);
    expect(out.ok).toBe(true);
    expect(out.hasChanges).toBe(true);
    expect(out.error).toBeNull();
    expect(out.baseBranch).toBe('origin/main');
    expect(out.files).toEqual([{ path: 'c.txt', status: 'add', oldPath: null }]);
  });
});