import { describe, it, expect } from "bun:test";
import { buildStatusOptionMap } from "./build-status-option-map";
import { InitConfigError } from "./init-config-error";
import type { ProjectV2SingleSelectField } from "./types";

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

describe("buildStatusOptionMap", () => {
  it("4 つの status すべての option id を返す", () => {
    const field = makeStatusField();

    const map = buildStatusOptionMap(field);

    expect(map).toEqual({
      draft: "opt_draft",
      refined: "opt_refined",
      "in-progress": "opt_in_progress",
      done: "opt_done",
    });
  });

  it("必要な option が欠けている場合はエラー", () => {
    const field = makeStatusField({
      options: [
        { id: "opt_draft", name: "draft" },
        { id: "opt_done", name: "done" },
      ],
    });

    expect(() => buildStatusOptionMap(field)).toThrowError(InitConfigError);
    expect(() => buildStatusOptionMap(field)).toThrowError(/missing required options/);
  });
});
