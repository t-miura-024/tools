import type { DiffTextIndex } from "./types.ts";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";

/// diff.txt に `filePath` がファイル見出しとして現れるか（純粋関数）。
///
/// 追加・変更ファイルは `+++ b/<path>`、削除ファイルは `--- a/<path>`、リネームは
/// `rename to <path>`（C-quote 形を含む）で現れる。text の新規追加は `diff --git
/// a/<path> b/<path>` 見出しでも現れ、バイナリ・空ファイルもこの見出しだけは出力される。
/// 判定は行の完全一致で行う（部分一致だと "a.txt" が "a.txt2" に誤ヒットし、
/// 打ち切りを見逃す）。非 ASCII 等の C-quote 形と、`core.quotePath=false` の
/// 生パス形、空白パスに git が付ける末尾タブ形の両方を候補にする。
/// diffRaw ではなくインデックス（indexDiffText）を受け取り、split を呼び出しごとに
/// 繰り返さない。
export function diffContainsPath(index: DiffTextIndex, filePath: string): boolean {
  const quoted = quoteGitPathForDiff(filePath);
  const candidates = new Set<string>([
    `diff --git a/${filePath} b/${filePath}`,
    `diff --git "a/${quoted}" "b/${quoted}"`,
    `+++ b/${filePath}`,
    `+++ b/${filePath}\t`,
    `+++ "b/${quoted}"`,
    `+++ "b/${quoted}"\t`,
    `--- a/${filePath}`,
    `--- a/${filePath}\t`,
    `--- "a/${quoted}"`,
    `--- "a/${quoted}"\t`,
    `rename to ${filePath}`,
    `rename to "${quoted}"`,
    `rename from ${filePath}`,
    `rename from "${quoted}"`,
  ]);
  for (const candidate of candidates) {
    if (index.lineSet.has(candidate)) return true;
  }
  return false;
}
