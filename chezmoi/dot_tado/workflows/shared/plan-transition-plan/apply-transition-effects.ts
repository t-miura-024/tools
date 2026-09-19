import type { TransitionSideEffect } from "./types";
import type { ApplyTransitionEffectsOptions } from "./types";
import { TransitionPlanError } from "./transition-plan-error";
import { appendHistoryEntry } from "./append-history-entry";

export async function applyTransitionEffects(
  options: ApplyTransitionEffectsOptions,
): Promise<TransitionSideEffect> {
  const executionMarker = options.executionTransition ? crypto.randomUUID() : null;

  await options.updateItemStatus({
    projectId: options.config.projectId,
    itemId: options.itemId,
    fieldId: options.config.statusFieldId,
    optionId: options.config.statusOptions[options.targetStatus],
  });

  const shouldClose = options.targetStatus === "done";
  let issueStateChanged = false;
  try {
    await options.updateIssueState({
      repo: options.repo,
      number: options.number,
      state: shouldClose ? "closed" : "open",
    });
    issueStateChanged = true;
  } catch (error) {
    if (!(error instanceof TransitionPlanError)) throw error;
  }

  let bodyUpdated = false;
  if (!options.skipHistoryAppend) {
    const currentBody = await options.readIssueBody({ repo: options.repo, number: options.number });
    const newBody = appendHistoryEntry(
      currentBody,
      options.sourceStatus,
      options.targetStatus,
      options.executionTransition,
      executionMarker,
    );
    await options.updateIssueBody({ repo: options.repo, number: options.number, body: newBody });
    bodyUpdated = true;
  }

  return {
    itemId: options.itemId,
    number: options.number,
    sourceStatus: options.sourceStatus,
    targetStatus: options.targetStatus,
    bodyUpdated,
    issueStateChanged,
    issueClosed: shouldClose,
  };
}
