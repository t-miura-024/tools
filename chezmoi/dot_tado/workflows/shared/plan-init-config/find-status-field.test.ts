import { describe, it, expect } from "bun:test";
import { findStatusField } from "./find-status-field";
import type { ProjectV2Field, ProjectV2SingleSelectField } from "./types";

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

describe("findStatusField", () => {
  it("Status 名の single select field を返す", () => {
    const fields: ProjectV2Field[] = [makeStatusField(), { id: "PVTF_other", name: "Assignees" }];

    const result = findStatusField(fields);

    expect(result?.id).toBe("PVTF_status");
    expect(result?.name).toBe("Status");
  });

  it("Status field が見つからない場合は null を返す", () => {
    const fields: ProjectV2Field[] = [{ id: "PVTF_other", name: "Assignees" }];

    expect(findStatusField(fields)).toBeNull();
  });

  it("Status field が options を持たない場合は null を返す", () => {
    const fields: ProjectV2Field[] = [{ id: "PVTF_status", name: "Status" }];

    expect(findStatusField(fields)).toBeNull();
  });

  it("fieldName オプションで別名も検索できる", () => {
    const fields: ProjectV2Field[] = [makeStatusField({ name: "PlanStatus" })];

    const result = findStatusField(fields, "PlanStatus");

    expect(result?.name).toBe("PlanStatus");
  });
});
