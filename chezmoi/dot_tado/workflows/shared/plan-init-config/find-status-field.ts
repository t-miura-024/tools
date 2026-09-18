import type { ProjectV2Field, ProjectV2SingleSelectField } from "./types";

export function findStatusField(
  fields: readonly ProjectV2Field[],
  fieldName = "Status",
): ProjectV2SingleSelectField | null {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    return null;
  }

  if (!field.options || field.options.length === 0) {
    return null;
  }

  return {
    id: field.id,
    name: field.name,
    options: field.options,
  };
}
