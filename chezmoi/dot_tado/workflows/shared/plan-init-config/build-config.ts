import type { MtPlanConfig, ProjectV2 } from "./types";
import { InitConfigError } from "./init-config-error";
import { findStatusField } from "./find-status-field";
import { buildStatusOptionMap } from "./build-status-option-map";

export function buildConfig(
  project: ProjectV2,
  options: { statusFieldName?: string } = {},
): MtPlanConfig {
  const statusField = findStatusField(project.fields.nodes, options.statusFieldName ?? "Status");

  if (!statusField) {
    throw new InitConfigError(
      `Project ${project.owner.login}/${project.number} does not have a 'Status' single select field. ` +
        `Add it via the Project UI first, then re-run init.`,
    );
  }

  return {
    owner: project.owner.login,
    projectNumber: project.number,
    projectId: project.id,
    statusFieldId: statusField.id,
    statusOptions: buildStatusOptionMap(statusField),
  };
}
