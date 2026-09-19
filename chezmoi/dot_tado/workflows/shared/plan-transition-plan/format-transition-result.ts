import type { TransitionPlanResult } from "./types";

export function formatTransitionResult(result: TransitionPlanResult): string {
  const lines = [
    "Plan status transitioned.",
    `number: #${result.number}`,
    `status: ${result.sourceStatus} -> ${result.targetStatus}`,
    `item: ${result.itemId}`,
    `history: ${result.bodyUpdated ? "appended" : "skipped"}`,
    `issue: ${result.issueStateChanged ? (result.issueClosed ? "closed" : "reopened") : "unchanged"}`,
  ];
  if (result.parentTransition) {
    lines.push(
      `parent: #${result.parentTransition.number} ${result.parentTransition.sourceStatus} -> ${result.parentTransition.targetStatus}`,
    );
  }
  return lines.join("\n");
}
