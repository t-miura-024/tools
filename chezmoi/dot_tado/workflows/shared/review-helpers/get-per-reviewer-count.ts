import type { Depth } from "./types.ts";
import { DEPTH_TO_PER_COUNT } from "./depth-to-per-count.ts";

export function getPerReviewerCount(depth: Depth, total: number): number {
  const per = DEPTH_TO_PER_COUNT[depth];
  if (per === undefined) throw new Error(`unknown depth: ${depth}`);
  if (per === -1) return total;
  return per;
}
