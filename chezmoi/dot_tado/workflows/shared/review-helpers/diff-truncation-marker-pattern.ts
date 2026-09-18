// =============================================================================
// diff.txt の完全性検証 — untracked 打ち切り・truncate マーカーの検出
// =============================================================================

/// 検証者プロンプトへの転記時に付記する truncate マーカー
/// （run_reviewers が diff.txt のコピーを切り詰めるときだけ使う）。
/// diff.txt 自体にこの行が現れたら、機械照合（normalize / audit）の SoT が
/// 打ち切られている（表示用の切り詰めと SoT を混同している）。
export const DIFF_TRUNCATION_MARKER_PATTERN = /^\[\.\.\. truncated: \d+ lines omitted\]\s*$/;
