import type { DifitSelectionView } from "./types.ts";
import { isRecord } from "./is-record.ts";

export function parseDifitSelectionView(value: unknown): DifitSelectionView | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.base !== "string" || typeof value.target !== "string") return undefined;
  return {
    base: value.base,
    target: value.target,
    ...(typeof value.baseMode === "string" ? { baseMode: value.baseMode } : {}),
  };
}
