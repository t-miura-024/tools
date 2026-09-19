/// Rust の `DriftDetection` が出力し得る値（`#[serde(rename_all = "lowercase")]`）。
export const VALID_DIFIT_DRIFT_DETECTIONS: ReadonlySet<string> = new Set([
  "detected",
  "none",
  "unavailable",
]);
