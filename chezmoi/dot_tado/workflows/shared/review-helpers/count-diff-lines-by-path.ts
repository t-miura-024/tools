import type { DiffPathLineCounts } from "./types.ts";
import { parseDiffHeaderPath } from "./parse-diff-header-path.ts";

/// diff.txt からファイル別の追加/削除行数を集計する（純粋関数）。
///
/// `git diff --numstat` のファイル別行数と突合し、head 等による部分出力（ファイル丸ごと
/// 欠落・行数不一致）を検出するために使う。キーは new 側のパス（`+++ b/<path>`）とし、
/// 削除ファイルは old 側のパス（`--- a/<path>`）で数える（numstat も削除は old 側の
/// パスを返す）。リネームは `+++ b/<new>` に集約され、numstat の new 側パスと一致する。
/// バイナリ・モード変更のみのファイルは +/- 行を持たないため現れない（突合側が
/// 行数なしエントリとして扱う）。hunk 内の `+++` / `---` 始まりの内容行はヘッダと
/// 誤認せず +/- の行として数える。
export function countDiffLinesByPath(diffRaw: string): Map<string, DiffPathLineCounts> {
  const result = new Map<string, DiffPathLineCounts>();
  const countsFor = (filePath: string): DiffPathLineCounts => {
    let counts = result.get(filePath);
    if (!counts) {
      counts = { added: 0, deleted: 0 };
      result.set(filePath, counts);
    }
    return counts;
  };

  let currentPath: string | null = null;
  let inHunk = false;
  for (const line of diffRaw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // `--- a/<path>` / `+++ b/<path>` はヘッダ。`+++ /dev/null`（追加）は
      // currentPath を更新せず、`--- /dev/null`（新規追加の old 側）も同様。
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const parsed = parseDiffHeaderPath(line.slice(4));
        if (parsed !== null) currentPath = parsed;
      }
      continue;
    }
    if (currentPath === null) continue;
    if (line.startsWith("+")) countsFor(currentPath).added += 1;
    else if (line.startsWith("-")) countsFor(currentPath).deleted += 1;
  }
  return result;
}
