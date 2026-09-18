import type { DifitSelectionView } from "./types.ts";
import { formatDifitSelectionMismatch } from "./format-difit-selection-mismatch.ts";
import { formatDifitSelectionView } from "./format-difit-selection-view.ts";

/// state.selection と effort.json 由来の期待選択の一致を検証する（純粋関数）。
/// 不一致理由を返す（一致なら undefined）。差分提示範囲のドリフトを fail-closed に扱う。
///
/// 期待選択（短縮ハッシュの桁数・merge-base の解決基準）は difit 内部実装の写経であり、
/// difit 側の解決形式が変わると state.selection と一致しなくなる。不一致時は
/// 「difit 側の解決形式変更の可能性」を理由に含め、parity テスト（difit dist の
/// shortHash との比較）で検知できることを案内する。
export function validateDifitSelection(
  actual: DifitSelectionView | undefined,
  expected: DifitSelectionView,
): string | undefined {
  if (!actual) {
    return "difit state に selection（選択固定キー）が記録されていません。選択固定の契約を満たすセッションを `mt difit start` で開始し直してください";
  }
  if (
    actual.baseMode === "merge-base" &&
    actual.base === expected.base &&
    actual.target === expected.target
  ) {
    return undefined;
  }
  return `difit の選択が effort.json の base/target と一致しません（state: ${formatDifitSelectionMismatch(actual)} / 期待: ${formatDifitSelectionView(expected)}）。検証対象の diff.txt と difit に提示された差分が乖離しているため fail とします。期待値は difit 内部の解決形式（短縮ハッシュ先頭 7 文字・merge-base 基準）の写経であり、difit 側の解決形式変更の可能性がある場合は parity テスト（./expected-difit-selection.test.ts）と difit CLI の出力を確認してください`;
}
