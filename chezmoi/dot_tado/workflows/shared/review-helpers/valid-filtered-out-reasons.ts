/// `filteredOut.items[].reason` として受理する値（filterFindingsByDiff の機械導出と同期）。
export const VALID_FILTERED_OUT_REASONS: ReadonlySet<string> = new Set([
  "file_not_in_diff",
  "line_not_in_added",
  "missing_position",
  "old_side",
  "missing_filePath",
]);
