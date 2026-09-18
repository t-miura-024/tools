import type { DifitSelectionView } from "./types.ts";

export function formatDifitSelectionView(view: DifitSelectionView | undefined): string {
  if (!view) return "不明";
  return `base=${view.base} target=${view.target} baseMode=${view.baseMode ?? "direct"}`;
}
