import type { DifitSelectionDrift } from "./types.ts";

/// `mt difit check --dry-run` / `threads --json` の `selection_drift` を
/// fail-closed の契約として取り出す。
///
/// 両コマンドは選択ドリフト検知を常に含む契約（Rust 側で `Option` ではなく必須）。
/// フィールド欠落・解釈不能を「ドリフトなし」と混同せず契約違反として返し、
/// 呼び出し元（start_difit_review / collect_verdict）が通過・後始末を認めないようにする。
/// done 出力は drift を省略し得るため、この関数の対象外（ゲート判定に使わない）。
export function requireDifitSelectionDrift(output: {
  selection_drift?: DifitSelectionDrift;
  selection_drift_error?: string;
}): { drift: DifitSelectionDrift } | { violation: string } {
  if (output.selection_drift_error) {
    return {
      violation: `selection_drift を解釈できません（契約違反）: ${output.selection_drift_error}。difit CLI の出力スキーマ変更を検知しています`,
    };
  }
  if (!output.selection_drift) {
    return {
      violation:
        "selection_drift が出力にありません（契約違反）。`mt difit threads --json` / `check --dry-run` は選択ドリフト検知を常に含む契約です",
    };
  }
  return { drift: output.selection_drift };
}
