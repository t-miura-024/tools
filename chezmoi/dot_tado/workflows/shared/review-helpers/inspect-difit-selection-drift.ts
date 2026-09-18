import type { DifitDriftDetection, DifitSelectionDrift } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { parseDifitSelectionView } from "./parse-difit-selection-view.ts";
import { VALID_DIFIT_DRIFT_DETECTIONS } from "./valid-difit-drift-detections.ts";

/// `selection_drift` の解釈結果（フィールド欠落と解釈不能を区別する）。
/// - `{ drift }`: 解釈できた
/// - `{ error }`: フィールドは存在するが解釈できない（契約違反）
/// - `undefined`: フィールドが存在しない（done など probe しない経路では正当）
export function inspectDifitSelectionDrift(
  value: unknown,
): { drift: DifitSelectionDrift } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return { error: "selection_drift がオブジェクトではありません" };
  }
  const detection = value.detection;
  if (typeof detection !== "string" || !VALID_DIFIT_DRIFT_DETECTIONS.has(detection)) {
    return { error: `selection_drift.detection が未知の値です: ${String(detection)}` };
  }
  const expected = parseDifitSelectionView(value.expected);
  const current = parseDifitSelectionView(value.current);
  return {
    drift: {
      detection: detection as DifitDriftDetection,
      ...(expected ? { expected } : {}),
      ...(current ? { current } : {}),
    },
  };
}
