import { describe, it, expect } from "bun:test";
import { serializeConfig } from "./serialize-config";
import { parseConfig } from "./parse-config";
import type { MtPlanConfig } from "./types";

const sample: MtPlanConfig = {
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

describe("serializeConfig", () => {
  it("serialize → parse でラウンドトリップできる", () => {
    const serialized = serializeConfig(sample);
    const parsed = parseConfig(serialized);

    expect(parsed).toEqual(sample);
  });
});
