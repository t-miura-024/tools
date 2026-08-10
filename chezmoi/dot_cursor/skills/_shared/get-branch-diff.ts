#!/usr/bin/env bun
/**
 * ブランチ差分取得スクリプト。
 *
 * 使い方:
 *   bun run get-branch-diff.ts                ... origin/HEAD（デフォルトブランチ）と現在の HEAD の差分
 *   bun run get-branch-diff.ts <base>         ... <base> と現在の HEAD の差分
 *   bun run get-branch-diff.ts <base>..<head> ... <base> と <head> の差分
 *
 * 差分は常に merge-base 経由で計算する。標準出力は JSON のみ。
 * 成功時は終了コード 0、処理不能時は理由付きエラー JSON を出力して非ゼロ終了する。
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

const STATUS_MAP: Record<string, string> = {
  A: 'add',
  M: 'modify',
  D: 'delete',
  R: 'rename',
  C: 'copy',
};

function git(...args: string[]): GitResult {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
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
  const parts = raw.split('\0').filter((part) => part.length > 0);
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const token = parts[i++];
    const code = token[0];
    if (code === 'R' || code === 'C') {
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
function parseNumstat(raw: string): { files: number; insertions: number; deletions: number } {
  const lines = raw.trim() ? raw.trim().split('\n') : [];
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [ins, del] = line.split('\t');
    const insNum = Number(ins);
    const delNum = Number(del);
    if (Number.isInteger(insNum)) insertions += insNum;
    if (Number.isInteger(delNum)) deletions += delNum;
  }
  return { files: lines.length, insertions, deletions };
}

// --- リポジトリルートの解決。git は親ディレクトリを遡るため、サブディレクトリからも実行できる ---
const top = git('rev-parse', '--show-toplevel');
if (top.code !== 0) {
  fail(`Git リポジトリのルートを解決できません: ${top.stderr.trim() || 'Git リポジトリ外で実行されました'}`);
}

// --- 引数解析とベース解決 ---
const spec = Bun.argv[2] ?? '';

let base: string;
let head: string;
let baseBranch: string;

if (spec.includes('..')) {
  const parts = spec.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`引数形式が不正です: <base>..<head> 形式で指定してください（実際: ${spec}）`);
  }
  base = parts[0];
  head = parts[1];
  baseBranch = base;
} else if (spec) {
  base = spec;
  head = 'HEAD';
  baseBranch = spec;
} else {
  const sym = git('symbolic-ref', 'refs/remotes/origin/HEAD');
  if (sym.code !== 0) {
    fail('origin/HEAD が未設定です。git remote set-head origin --auto で設定してください');
  }
  // refs/remotes/origin/main → origin/main、refs/heads/main → main のように表記を正規化する
  baseBranch = sym.stdout.trim().replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');
  base = baseBranch;
  head = 'HEAD';
}

// --- ベース / ヘッドの解決確認 ---
for (const [label, commitish] of [
  ['base', base],
  ['head', head],
] as const) {
  const verify = git('rev-parse', '--verify', '--quiet', `${commitish}^{commit}`);
  if (verify.code !== 0) {
    fail(`${label} を解決できません: ${commitish}`);
  }
}

// --- merge-base の計算 ---
const mb = git('merge-base', base, head);
if (mb.code !== 0) {
  fail(`merge-base を計算できません（${base} と ${head} に共通祖先がありません）: ${mb.stderr.trim() || '共通祖先なし'}`);
}
const mergeBase = mb.stdout.trim();

// --- 差分の取得（name-status / numstat / raw diff を別々に取得する） ---
const ns = git('diff', '-z', '-M', '--name-status', mergeBase, head);
if (ns.code !== 0) fail(`差分一覧を取得できません: ${ns.stderr.trim()}`);

const numstat = git('diff', '--numstat', '-M', mergeBase, head);
if (numstat.code !== 0) fail(`変更統計を取得できません: ${numstat.stderr.trim()}`);

const raw = git('diff', '-M', '--no-ext-diff', '--full-index', mergeBase, head);
if (raw.code !== 0) fail(`raw diff を取得できません: ${raw.stderr.trim()}`);

const files = parseNameStatus(ns.stdout);
const stat = parseNumstat(numstat.stdout);
const hasChanges = files.length > 0;

console.log(
  JSON.stringify({
    ok: true,
    hasChanges,
    error: null,
    baseBranch,
    mergeBase,
    files,
    stat,
    rawDiff: hasChanges ? raw.stdout : '',
  }),
);
process.exit(0);