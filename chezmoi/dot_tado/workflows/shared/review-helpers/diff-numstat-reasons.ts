import type { DiffNumstatEntry } from "./types.ts";
import { countDiffLinesByPath } from "./count-diff-lines-by-path.ts";
import { diffContainsPath } from "./diff-contains-path.ts";
import { indexDiffText } from "./index-diff-text.ts";

/// `git diff --numstat` のファイル別追加/削除行数と diff.txt の集計を突合する（純粋関数）。
///
/// 空配列なら一致。ファイル丸ごと欠落は `diffContainsPath` の見出し一致で、行数不一致は
/// `countDiffLinesByPath` の集計で検出し、理由を返す（呼び出し元が head 等による部分出力を
/// fail にできる）。行数を持たないエントリ（バイナリ等）は見出しの出現だけを検証する。
export function diffNumstatReasons(
  diffRaw: string,
  entries: readonly DiffNumstatEntry[],
): string[] {
  const index = indexDiffText(diffRaw);
  const counts = countDiffLinesByPath(diffRaw);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of entries) {
    if (!diffContainsPath(index, entry.path)) {
      missing.push(entry.path);
      continue;
    }
    if (entry.added === null || entry.deleted === null) continue;
    const actual = counts.get(entry.path) ?? { added: 0, deleted: 0 };
    if (actual.added !== entry.added || actual.deleted !== entry.deleted) {
      mismatched.push(
        `${entry.path} (numstat +${entry.added}/-${entry.deleted}, diff.txt +${actual.added}/-${actual.deleted})`,
      );
    }
  }
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(
      `diff.txt に git diff --numstat のファイルが ${missing.length} 件欠落しています: ${missing.join(", ")}。head 等による打ち切り、または収集範囲の不一致を検出しました。diff.txt は機械照合（normalize / audit）の SoT であり、省略せず完全に収集してください`,
    );
  }
  if (mismatched.length > 0) {
    reasons.push(
      `diff.txt のファイル別追加/削除行数が git diff --numstat と一致しません: ${mismatched.join(" / ")}。途中で打ち切られた diff.txt を SoT にしないでください`,
    );
  }
  return reasons;
}
