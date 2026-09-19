import { PLAN_STATUSES } from "./plan-statuses";
import type { PlanStatus, ProjectV2SingleSelectField, StatusOptionMap } from "./types";
import { InitConfigError } from "./init-config-error";

export function buildStatusOptionMap(statusField: ProjectV2SingleSelectField): StatusOptionMap {
  const map = {} as StatusOptionMap;
  const missing: PlanStatus[] = [];

  for (const status of PLAN_STATUSES) {
    const option = statusField.options.find((candidate) => candidate.name === status);
    if (!option) {
      missing.push(status);
      continue;
    }
    map[status] = option.id;
  }

  if (missing.length > 0) {
    throw new InitConfigError(
      `Status field '${statusField.name}' is missing required options: ${missing.join(", ")}. ` +
        `Found options: ${statusField.options.map((option) => option.name).join(", ")}.`,
    );
  }

  return map;
}
