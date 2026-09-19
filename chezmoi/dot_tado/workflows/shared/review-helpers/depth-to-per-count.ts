import type { Depth } from "./types.ts";

export const DEPTH_TO_PER_COUNT: Record<Depth, number> = {
  max: 1,
  xhigh: 2,
  high: 3,
  medium: 4,
  low: -1,
};
