import type { Depth, Width } from "./types.ts";
import { getReviewerAssignments } from "./get-reviewer-assignments.ts";

export function getReviewerCount(width: Width, depth: Depth): number {
  return getReviewerAssignments(width, depth).length;
}
