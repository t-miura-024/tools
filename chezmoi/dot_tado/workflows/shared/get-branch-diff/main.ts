#!/usr/bin/env bun
/**
 * ブランチ差分取得スクリプト。
 *
 * 使い方:
 *   bun run main.ts                ... origin/HEAD（デフォルトブランチ）と現在の HEAD の差分
 *   bun run main.ts <base>         ... <base> と現在の HEAD の差分
 *   bun run main.ts <base>..<head> ... <base> と <head> の差分
 *
 * 差分は常に merge-base 経由で計算する。標準出力は JSON のみ。
 * 成功時は終了コード 0、処理不能時は理由付きエラー JSON を出力して非ゼロ終了する。
 */
import { git } from "./git";
import { fail } from "./fail";
import { truncateStderr } from "./truncate-stderr";
import { isValidCommitish } from "./is-valid-commitish";
import { parseNameStatus } from "./parse-name-status";
import { parseNumstat } from "./parse-numstat";

// --- リポジトリルートの解決。git は親ディレクトリを遡るため、サブディレクトリからも実行できる ---
const top = git("rev-parse", "--show-toplevel");
if (top.code !== 0) {
  fail(
    `Git リポジトリのルートを解決できません: ${truncateStderr(top.stderr) || "Git リポジトリ外で実行されました"}`,
  );
}

// --- 引数解析とベース解決 ---
const spec = Bun.argv[2] ?? "";

let base: string;
let head: string;
let baseBranch: string;

if (spec.includes("..")) {
  const parts = spec.split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`引数形式が不正です: <base>..<head> 形式で指定してください（実際: ${spec}）`);
  }
  base = parts[0];
  head = parts[1];
  baseBranch = base;
} else if (spec) {
  base = spec;
  head = "HEAD";
  baseBranch = spec;
} else {
  const sym = git("symbolic-ref", "refs/remotes/origin/HEAD");
  if (sym.code !== 0) {
    fail("origin/HEAD が未設定です。git remote set-head origin --auto で設定してください");
  }
  // refs/remotes/origin/main → origin/main、refs/heads/main → main のように表記を正規化する
  baseBranch = sym.stdout
    .trim()
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/heads\//, "");
  base = baseBranch;
  head = "HEAD";
}

// --- ベース / ヘッドの解決確認 ---
// 形状検証を先に行い、`-`始まり等のオプション解釈をgitに到達させない（fail-closed）。
for (const [label, commitish] of [
  ["base", base],
  ["head", head],
] as const) {
  if (!isValidCommitish(commitish)) {
    fail(`${label} の形式が不正です: ${commitish}`);
  }
}
for (const [label, commitish] of [
  ["base", base],
  ["head", head],
] as const) {
  // 先頭`--`はrev-parseの意味を変える（path扱いで検証失敗）ため末尾に置く。
  // 実測: `rev-parse --verify --quiet -- <rev>`は失敗、`... <rev> --`は成功。
  const verify = git("rev-parse", "--verify", "--quiet", `${commitish}^{commit}`, "--");
  if (verify.code !== 0) {
    fail(`${label} を解決できません: ${commitish}`);
  }
}

// --- merge-base の計算 ---
// merge-baseは先頭`--`が有効（実測で成功）なためcommitish直前に挿入する。
const mb = git("merge-base", "--", base, head);
if (mb.code !== 0) {
  fail(
    `merge-base を計算できません（${base} と ${head} に共通祖先がありません）: ${truncateStderr(mb.stderr) || "共通祖先なし"}`,
  );
}
const mergeBase = mb.stdout.trim();

// --- 差分の取得（name-status / numstat / raw diff を別々に取得する） ---
// diffは先頭`--`がrevをpath扱いに変える（実測で空差分になる）ため末尾に置く。
// commitishのオプション解釈は上記の形状検証で遮断済み。末尾`--`はpath混入防止。
const ns = git("diff", "-z", "-M", "--name-status", mergeBase, head, "--");
if (ns.code !== 0) fail(`差分一覧を取得できません: ${truncateStderr(ns.stderr)}`);

const numstat = git("diff", "--numstat", "-M", mergeBase, head, "--");
if (numstat.code !== 0) fail(`変更統計を取得できません: ${truncateStderr(numstat.stderr)}`);

const raw = git("diff", "-M", "--no-ext-diff", "--full-index", mergeBase, head, "--");
if (raw.code !== 0) fail(`raw diff を取得できません: ${truncateStderr(raw.stderr)}`);

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
    rawDiff: hasChanges ? raw.stdout : "",
  }),
);
process.exit(0);
