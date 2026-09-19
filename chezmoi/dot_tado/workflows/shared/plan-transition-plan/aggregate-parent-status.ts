import type { AggregateParentStatusOptions, TransitionSideEffect } from "./types";
import { applyTransitionEffects } from "./apply-transition-effects";
import { isLatestTransitionRecorded } from "./is-latest-transition-recorded";
import { allChildrenDoneThroughTransition } from "./all-children-done-through-transition";

export async function aggregateParentStatus(
  options: AggregateParentStatusOptions,
): Promise<TransitionSideEffect | undefined> {
  if (options.parentNumber === null) return undefined;

  let subIssueNumbers: number[];
  try {
    subIssueNumbers = await options.listSubIssueNumbers({
      repo: options.repo,
      number: options.parentNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[mt-plan] failed to list sub-issues for parent #${options.parentNumber}: ${message}\n`,
    );
    return undefined;
  }
  if (subIssueNumbers.length === 0) return undefined;

  const [parent, children] = await Promise.all([
    options.findPlanItem({
      config: options.config,
      number: options.parentNumber,
      repo: options.repo,
    }),
    Promise.all(
      subIssueNumbers.map((number) =>
        options
          .findPlanItem({ config: options.config, number, repo: options.repo })
          .then((plan) => ({ number, currentStatus: plan.currentStatus })),
      ),
    ),
  ]);
  const targetStatus =
    options.childTargetStatus === "in-progress" &&
    (await isLatestTransitionRecorded(options, options.childNumber))
      ? "in-progress"
      : options.childTargetStatus === "done" &&
          (await allChildrenDoneThroughTransition(options, children))
        ? "done"
        : undefined;

  if (!targetStatus) return undefined;

  const latestParent = await options.findPlanItem({
    config: options.config,
    number: options.parentNumber,
    repo: options.repo,
  });
  if (latestParent.currentStatus === targetStatus) return undefined;

  return applyTransitionEffects({
    config: options.config,
    number: options.parentNumber,
    repo: parent.repo,
    itemId: parent.itemId,
    sourceStatus: latestParent.currentStatus,
    targetStatus,
    updateItemStatus: options.updateItemStatus,
    updateIssueState: options.updateIssueState,
    readIssueBody: options.readIssueBody,
    updateIssueBody: options.updateIssueBody,
    skipHistoryAppend: options.skipHistoryAppend,
    executionTransition: false,
  });
}
