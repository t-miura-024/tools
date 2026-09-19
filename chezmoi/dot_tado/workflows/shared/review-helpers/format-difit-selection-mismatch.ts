import type { DifitSelectionView } from "./types.ts";

export function formatDifitSelectionMismatch(actual: DifitSelectionView | undefined): string {
  if (!actual) return "未記録";
  return `base=${actual.base} target=${actual.target} baseMode=${actual.baseMode ?? "direct"}`;
}
