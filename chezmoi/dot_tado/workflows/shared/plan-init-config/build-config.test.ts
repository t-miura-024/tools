import { describe, it, expect } from "bun:test";
import { buildConfig } from "./build-config";
import { InitConfigError } from "./init-config-error";
import type { ProjectV2, ProjectV2Field, ProjectV2SingleSelectField } from "./types";

function makeStatusField(
  overrides: Partial<{
    id: string;
    name: string;
    options: Array<{ id: string; name: string }>;
  }> = {},
): ProjectV2SingleSelectField {
  return {
    id: "PVTF_status",
    name: "Status",
    options: [
      { id: "opt_draft", name: "draft" },
      { id: "opt_refined", name: "refined" },
      { id: "opt_in_progress", name: "in-progress" },
      { id: "opt_done", name: "done" },
    ],
    ...overrides,
  };
}

function makeProject(fields: ProjectV2Field[], overrides: Partial<ProjectV2> = {}): ProjectV2 {
  return {
    id: "PVT_test",
    number: 4,
    title: "plans",
    owner: { __typename: "User", login: "t-miura-024" },
    fields: { nodes: fields },
    ...overrides,
  };
}

describe("buildConfig", () => {
  it("Project から完全な MtPlanConfig を生成する", () => {
    const project = makeProject([makeStatusField()]);

    const config = buildConfig(project);

    expect(config).toEqual({
      owner: "t-miura-024",
      projectNumber: 4,
      projectId: "PVT_test",
      statusFieldId: "PVTF_status",
      statusOptions: {
        draft: "opt_draft",
        refined: "opt_refined",
        "in-progress": "opt_in_progress",
        done: "opt_done",
      },
    });
  });

  it("Status field がない Project ではエラー", () => {
    const project = makeProject([{ id: "PVTF_other", name: "Assignees" }]);

    expect(() => buildConfig(project)).toThrowError(InitConfigError);
    expect(() => buildConfig(project)).toThrowError(/does not have a 'Status' single select field/);
  });
});
