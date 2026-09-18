import type { DifitSelectionDrift } from "./types.ts";
import { formatDifitSelectionView } from "./format-difit-selection-view.ts";

/// 選択ドリフトの復旧手順を含む理由文を組み立てる。
///
/// ゲート判定とコメント追加は起動時の選択（state.selection）に固定される。
/// - `detected`: UI のセレクタを起動時の選択へ戻すまで reply / resolve は
///   ゲートが読まない別セッションへ書き込まれるため、セレクタ復旧を案内する。
/// - `unavailable`: probe 失敗で検知不能。ドリフトなしと混同せず fail-closed に
///   扱うため、`mt difit start` によるセッション復旧と UI 選択の確認を案内する。
export function describeDifitSelectionDrift(drift: DifitSelectionDrift): string {
  if (drift.detection === "unavailable") {
    return (
      "difit サーバの現在の選択を確認できませんでした（GET /api/diff の probe 失敗＝検知不能）。" +
      `ゲート判定とコメント追加は起動時の選択（${formatDifitSelectionView(drift.expected)}）に固定されていますが、` +
      "difit UI での reply / resolve が同じセッションへ向かうことは確認できていません。" +
      "`mt difit start <base-branch>` でセッションを復旧し、" +
      "difit UI のリビジョンセレクタが起動時の選択（base/target）を指していることを確認してから reply / resolve してください"
    );
  }
  if (drift.detection === "none") {
    return "difit サーバの現在の選択は起動時の選択と一致しています（ドリフトなし）";
  }
  return (
    "difit UI のリビジョンセレクタが起動時の選択と異なります" +
    `（起動時: ${formatDifitSelectionView(drift.expected)} / 現在: ${formatDifitSelectionView(drift.current)}）。` +
    "ゲート判定とコメント追加は起動時のセッションに固定されているため、" +
    "このままでは UI での reply / resolve は別セッションへ書き込まれ、ゲートに届きません。" +
    "difit UI のリビジョンセレクタを起動時の選択に戻してから resolve / reply し直してください"
  );
}
