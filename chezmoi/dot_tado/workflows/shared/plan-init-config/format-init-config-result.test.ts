import { describe, it, expect } from "bun:test";
import { formatInitConfigResult } from "./format-init-config-result";
import type { MtPlanConfig } from "./types";

describe("formatInitConfigResult", () => {
  it("config の主要フィールドを表示する", () => {
    const config: MtPlanConfig = {
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
    };

    const output = formatInitConfigResult(config, "/tmp/config.json");

    expect(output).toContain("owner: t-miura-024");
    expect(output).toContain("project: 4 (PVT_test)");
    expect(output).toContain("statusField: PVTF_status");
    expect(output).toContain("- draft: opt_draft");
    expect(output).toContain("- done: opt_done");
  });
});
