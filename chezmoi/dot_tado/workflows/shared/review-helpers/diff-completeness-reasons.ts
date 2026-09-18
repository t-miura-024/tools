import { DIFF_TRUNCATION_MARKER_PATTERN } from "./diff-truncation-marker-pattern.ts";
import { findMissingUntrackedFiles } from "./find-missing-untracked-files.ts";
import { indexDiffText } from "./index-diff-text.ts";

/// diff.txt の完全性検証（truncate マーカー・untracked 欠落）の理由を返す（純粋関数）。
/// 空配列なら「収集コマンドの打ち切り・失敗なし」を意味する。
/// 行の展開は 1 回だけ行い、マーカー検査と untracked 突合で同じインデックスを共有する。
export function diffCompletenessReasons(
  diffRaw: string,
  untrackedFiles: readonly string[],
): string[] {
  const index = indexDiffText(diffRaw);
  const reasons: string[] = [];
  if (index.lines.some((line) => DIFF_TRUNCATION_MARKER_PATTERN.test(line))) {
    reasons.push(
      "diff.txt に truncate マーカー（[... truncated: N lines omitted]）が含まれています。diff.txt は normalize_findings / audit と検証者が参照する SoT であり、完全な差分でなければなりません（truncate は検証者プロンプトへの転記時のみに限定してください）",
    );
  }
  const missing = findMissingUntrackedFiles(index, untrackedFiles);
  if (missing.length > 0) {
    reasons.push(
      `diff.txt に untracked ファイルの差分が ${missing.length} 件欠落しています: ${missing.join(", ")}。head 等による打ち切り、または git diff 失敗の握り潰しを検出しました。diff.txt は機械照合（normalize / audit）の SoT であり、省略せず完全に収集してください`,
    );
  }
  return reasons;
}
