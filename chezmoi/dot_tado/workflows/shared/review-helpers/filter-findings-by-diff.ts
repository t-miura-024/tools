import type { FilteredOutItem, Finding } from "./types.ts";

export function filterFindingsByDiff(
  findings: Finding[],
  changedLinesMap: Map<string, Set<number>>,
): { kept: Finding[]; filteredOut: FilteredOutItem[] } {
  const kept: Finding[] = [];
  const filteredOut: FilteredOutItem[] = [];

  for (const f of findings) {
    const filePath = f.filePath?.trim() ?? "";
    const position = f.position;
    const line = position?.line;
    const side = (position as unknown as { side?: string })?.side;

    if (!filePath) {
      filteredOut.push({
        axis: f.axis,
        reason: "missing_filePath",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (!position || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        reason: "missing_position",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (side !== "new") {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "old_side",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    const set = changedLinesMap.get(filePath);
    if (!set) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "file_not_in_diff",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (!set.has(line)) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "line_not_in_added",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    kept.push(f);
  }

  return { kept, filteredOut };
}
