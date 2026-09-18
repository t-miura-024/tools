import type { Perspective, Width } from "./types.ts";
import { PERSPECTIVE_POOL } from "./perspective-pool.ts";
import { WIDTH_TO_COUNT } from "./width-to-count.ts";

export function getPerspectivesForWidth(width: Width): Perspective[] {
  const count = WIDTH_TO_COUNT[width];
  if (count === undefined) throw new Error(`unknown width: ${width}`);
  return PERSPECTIVE_POOL.slice(0, count) as Perspective[];
}
