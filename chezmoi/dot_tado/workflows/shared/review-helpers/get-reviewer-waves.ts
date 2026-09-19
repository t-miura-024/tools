import type { Depth, Perspective, Width } from "./types.ts";
import { getReviewerAssignments } from "./get-reviewer-assignments.ts";

export function getReviewerWaves(width: Width, depth: Depth, maxPerWave = 6): Perspective[][][] {
  const assignments = getReviewerAssignments(width, depth);
  const waves: Perspective[][][] = [];
  for (let i = 0; i < assignments.length; i += maxPerWave) {
    waves.push(assignments.slice(i, i + maxPerWave));
  }
  return waves;
}
