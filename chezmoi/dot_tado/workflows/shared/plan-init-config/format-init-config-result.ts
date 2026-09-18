import { PLAN_STATUSES } from "./plan-statuses";
import type { MtPlanConfig } from "./types";

export function formatInitConfigResult(config: MtPlanConfig, configPath: string): string {
  return [
    "mt-plan config initialized.",
    `config: ${configPath}`,
    `owner: ${config.owner}`,
    `project: ${config.projectNumber} (${config.projectId})`,
    `statusField: ${config.statusFieldId}`,
    "status options:",
    ...PLAN_STATUSES.map((status) => `  - ${status}: ${config.statusOptions[status]}`),
  ].join("\n");
}
