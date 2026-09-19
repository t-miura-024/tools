#!/usr/bin/env bun
/**
 * 作業ツリー差分取得スクリプト。
 *
 * 使い方:
 *   bun run main.ts
 *
 * ステージ済み / 未ステージ / 未追跡の変更を区別して JSON で返す。
 * 各セクションは変更一覧（files）、統計（stat）、詳細内容（diff）を持つ。
 * 未追跡ファイルは git diff の対象外のため、diff と行数は null（git が提供できない情報は null にする）。
 *
 * 標準出力は JSON のみ。差分なしは hasChanges: false と終了コード 0、
 * 処理不能時（Git リポジトリ外など）は理由付きエラー JSON と非ゼロ終了で返す。
 */
import { git } from "./git";
import { fail } from "./fail";
import { buildSection } from "./build-section";
import type { Section } from "./types";

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
