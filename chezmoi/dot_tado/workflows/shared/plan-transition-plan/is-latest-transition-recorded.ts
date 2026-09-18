import type { AggregateParentStatusOptions } from "./types";
import { latestRecordedMarker } from "./latest-recorded-marker";

export async function isLatestTransitionRecorded(
  options: AggregateParentStatusOptions,
  number: number,
): Promise<boolean> {
  const body = await options.readIssueBody({ repo: options.repo, number });
  return latestRecordedMarker(body) !== null;
}
