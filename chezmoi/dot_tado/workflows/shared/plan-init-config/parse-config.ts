import type { MtPlanConfig, PlanStatus } from "./types";
import { InitConfigError } from "./init-config-error";

export function parseConfig(input: string): MtPlanConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InitConfigError(`Failed to parse config JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new InitConfigError("Config must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;
  const required = ["owner", "projectNumber", "projectId", "statusFieldId", "statusOptions"];
  for (const key of required) {
    if (!(key in obj)) {
      throw new InitConfigError(`Config is missing required field: ${key}`);
    }
  }

  if (typeof obj.owner !== "string") {
    throw new InitConfigError("Config field 'owner' must be a string.");
  }
  if (typeof obj.projectNumber !== "number") {
    throw new InitConfigError("Config field 'projectNumber' must be a number.");
  }
  if (typeof obj.projectId !== "string") {
    throw new InitConfigError("Config field 'projectId' must be a string.");
  }
  if (typeof obj.statusFieldId !== "string") {
    throw new InitConfigError("Config field 'statusFieldId' must be a string.");
  }
  if (!obj.statusOptions || typeof obj.statusOptions !== "object") {
    throw new InitConfigError("Config field 'statusOptions' must be an object.");
  }

  const options = obj.statusOptions as Record<string, unknown>;
  const getStatusOption = (status: PlanStatus): string => {
    const value = options[status];
    if (typeof value !== "string") {
      throw new InitConfigError(`Config field 'statusOptions.${status}' must be a string.`);
    }
    return value;
  };

  return {
    owner: obj.owner,
    projectNumber: obj.projectNumber,
    projectId: obj.projectId,
    statusFieldId: obj.statusFieldId,
    statusOptions: {
      draft: getStatusOption("draft"),
      refined: getStatusOption("refined"),
      "in-progress": getStatusOption("in-progress"),
      done: getStatusOption("done"),
    },
  };
}
