#!/usr/bin/env bun
/**
 * 作業ツリー差分取得スクリプト。
 *
 * 使い方:
 *   bun run get-git-diff.ts
 *
 * ステージ済み / 未ステージ / 未追跡の変更を区別して JSON で返す。
 * 各セクションは変更一覧（files）、統計（stat）、詳細内容（diff）を持つ。
 * 未追跡ファイルは git diff の対象外のため、diff と行数は null（git が提供できない情報は null にする）。
 *
 * 標準出力は JSON のみ。差分なしは hasChanges: false と終了コード 0、
 * 処理不能時（Git リポジトリ外など）は理由付きエラー JSON と非ゼロ終了で返す。
 */

interface GitResult {
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

const STATUS_MAP: Record<string, string> = {
  A: "add",
  M: "modify",
  D: "delete",
  R: "rename",
  C: "copy",
};

function git(...args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, hasChanges: false, error }));
  process.exit(1);
}

function mapStatus(code: string): string {
  return STATUS_MAP[code] ?? code;
}

/** `-z --name-status` の NUL 区切り出力を変更一覧へ変換する。 */
function parseNameStatus(raw: string): FileChange[] {
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const token = parts[i++];
    const code = token[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (oldPath === undefined || newPath === undefined) break;
      files.push({ path: newPath, status: mapStatus(code), oldPath });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      files.push({ path, status: mapStatus(code), oldPath: null });
    }
  }
  return files;
}

/** `--numstat` の出力から統計を集計する。バイナリは '-' で行数不明のため数えない（推測で補完しない）。 */
function parseNumstat(raw: string): Stat {
  const lines = raw.trim() ? raw.trim().split("\n") : [];
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [ins, del] = line.split("\t");
    const insNum = Number(ins);
    const delNum = Number(del);
    if (Number.isInteger(insNum)) insertions += insNum;
    if (Number.isInteger(delNum)) deletions += delNum;
  }
  return { files: lines.length, insertions, deletions };
}

/** 追跡済み変更（staged / unstaged）のセクションを組み立てる。 */
function buildSection(gitArgs: string[]): Section {
  const ns = git("diff", ...gitArgs, "-z", "-M", "--name-status");
  if (ns.code !== 0) fail(`差分一覧を取得できません: ${ns.stderr.trim()}`);

  const numstat = git("diff", ...gitArgs, "--numstat", "-M");
  if (numstat.code !== 0) fail(`変更統計を取得できません: ${numstat.stderr.trim()}`);

  const diff = git("diff", ...gitArgs, "-M", "--no-ext-diff", "--full-index");
  if (diff.code !== 0) fail(`詳細内容を取得できません: ${diff.stderr.trim()}`);

  return {
    files: parseNameStatus(ns.stdout),
    stat: parseNumstat(numstat.stdout),
    diff: diff.stdout,
  };
}

// --- Git リポジトリの判定。git は親ディレクトリを遡るため、サブディレクトリからも実行できる ---
const top = git("rev-parse", "--show-toplevel");
if (top.code !== 0) {
  fail(
    `Git リポジトリのルートを解決できません: ${top.stderr.trim() || "Git リポジトリ外で実行されました"}`,
  );
}
const repoRoot = top.stdout.trim();

// --- ステージ済み / 未ステージの取得 ---
const staged = buildSection(["--cached"]);
const unstaged = buildSection([]);

// --- 未追跡の取得（git diff では取得できないため ls-files で一覧を得る） ---
// ls-files は cwd 配下のみを対象としパスも cwd 相対で返すため、
// サブディレクトリからの実行に備えてリポジトリルート基準で実行する。
const untrackedOut = git("-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z");
if (untrackedOut.code !== 0)
  fail(`未追跡ファイル一覧を取得できません: ${untrackedOut.stderr.trim()}`);

const untrackedPaths = untrackedOut.stdout.split("\0").filter((path) => path.length > 0);
const untracked: Section = {
  files: untrackedPaths.map((path) => ({ path, status: "untracked", oldPath: null })),
  stat: { files: untrackedPaths.length, insertions: null, deletions: null },
  diff: null,
};

const hasChanges =
  staged.files.length > 0 || unstaged.files.length > 0 || untracked.files.length > 0;

console.log(
  JSON.stringify({
    ok: true,
    hasChanges,
    error: null,
    staged,
    unstaged,
    untracked,
  }),
);
process.exit(0);
