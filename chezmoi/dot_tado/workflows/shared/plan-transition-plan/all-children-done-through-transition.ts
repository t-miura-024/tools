import type { PlanStatus } from "../plan-init-config/types";
import type { AggregateParentStatusOptions } from "./types";
import { isLatestTransitionRecorded } from "./is-latest-transition-recorded";

export async function allChildrenDoneThroughTransition(
  options: AggregateParentStatusOptions,
  children: Array<{ number: number; currentStatus: PlanStatus }>,
): Promise<boolean> {
  if (!children.every((child) => child.currentStatus === "done")) return false;

  return Promise.all(
    children.map((child) => isLatestTransitionRecorded(options, child.number)),
  ).then((recorded) => recorded.every(Boolean));
}
