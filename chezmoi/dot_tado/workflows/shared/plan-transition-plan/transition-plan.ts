import type { TransitionPlanOptions, TransitionPlanResult } from "./types";
import { assertPlanStatus } from "./types";
import { TransitionPlanError } from "./transition-plan-error";
import { applyTransitionEffects } from "./apply-transition-effects";
import { aggregateParentStatus } from "./aggregate-parent-status";
import { defaultFindPlanItem } from "./default-find-plan-item";
import { defaultUpdateItemStatus } from "./default-update-item-status";
import { defaultUpdateIssueState } from "./default-update-issue-state";
import { defaultReadIssueBody } from "./default-read-issue-body";
import { defaultUpdateIssueBody } from "./default-update-issue-body";
import { defaultGetParentIssueNumber } from "./default-get-parent-issue-number";
import { defaultListSubIssueNumbers } from "./default-list-sub-issue-numbers";

export async function transitionPlan(
  options: TransitionPlanOptions,
): Promise<TransitionPlanResult> {
  assertPlanStatus(options.targetStatus);

  const find = options.findPlanItem ?? defaultFindPlanItem;
  const found = await find({
    config: options.config,
    number: options.number,
    repo: options.repo,
  });
  const sourceStatus = found.currentStatus;

  const getParentIssueNumber = options.getParentIssueNumber ?? defaultGetParentIssueNumber;
  const listSubIssueNumbers = options.listSubIssueNumbers ?? defaultListSubIssueNumbers;
  const [parentNumber, subIssueNumbers] = await Promise.all([
    getParentIssueNumber({ repo: found.repo, number: options.number }),
    listSubIssueNumbers({ repo: found.repo, number: options.number }),
  ]);

  if (
    subIssueNumbers.length > 0 &&
    (options.targetStatus === "in-progress" || options.targetStatus === "done")
  ) {
    throw new TransitionPlanError(
      `Plan #${options.number} is a parent plan and cannot be executed. Run one of its Sub Issues instead.`,
    );
  }

  if (sourceStatus === options.targetStatus) {
    throw new TransitionPlanError(
      `Plan #${options.number} is already in status '${options.targetStatus}'.`,
    );
  }

  const result = await applyTransitionEffects({
    config: options.config,
    number: options.number,
    repo: found.repo,
    itemId: found.itemId,
    sourceStatus,
    targetStatus: options.targetStatus,
    updateItemStatus: options.updateItemStatus ?? defaultUpdateItemStatus,
    updateIssueState: options.updateIssueState ?? defaultUpdateIssueState,
    readIssueBody: options.readIssueBody ?? defaultReadIssueBody,
    updateIssueBody: options.updateIssueBody ?? defaultUpdateIssueBody,
    skipHistoryAppend: options.skipHistoryAppend ?? false,
    executionTransition:
      parentNumber !== null &&
      (options.targetStatus === "in-progress" || options.targetStatus === "done"),
  });

  const parentTransition = await aggregateParentStatus({
    config: options.config,
    repo: found.repo,
    parentNumber,
    findPlanItem: find,
    listSubIssueNumbers,
    updateItemStatus: options.updateItemStatus ?? defaultUpdateItemStatus,
    updateIssueState: options.updateIssueState ?? defaultUpdateIssueState,
    readIssueBody: options.readIssueBody ?? defaultReadIssueBody,
    updateIssueBody: options.updateIssueBody ?? defaultUpdateIssueBody,
    skipHistoryAppend: options.skipHistoryAppend ?? false,
    childTargetStatus: options.targetStatus,
    childNumber: options.number,
  });

  return { ...result, parentTransition };
}
