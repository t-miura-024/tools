import type { Depth, Perspective, Width } from "./types.ts";
import { getPerReviewerCount } from "./get-per-reviewer-count.ts";
import { getPerspectivesForWidth } from "./get-perspectives-for-width.ts";

export function getReviewerAssignments(width: Width, depth: Depth): Perspective[][] {
  const perspectives = getPerspectivesForWidth(width);
  const per = getPerReviewerCount(depth, perspectives.length);
  const assignments: Perspective[][] = [];
  for (let i = 0; i < perspectives.length; i += per) {
    assignments.push(perspectives.slice(i, i + per));
  }
  return assignments;
}
