import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initConfig } from "./init-config";
import { loadConfig } from "./load-config";
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

describe("initConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-init-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("mock fetchProject を渡すと config を生成・保存して返す", async () => {
    const project = makeProject([makeStatusField()]);
    const configPath = path.join(tmp, "config.json");

    const result = await initConfig({
      owner: "t-miura-024",
      projectNumber: 4,
      configPath,
      fetchProject: async () => project,
    });

    expect(result.config.owner).toBe("t-miura-024");
    expect(result.config.projectNumber).toBe(4);
    expect(result.config.statusOptions.draft).toBe("opt_draft");
    expect(result.project).toBe(project);
    expect(fs.existsSync(configPath)).toBe(true);

    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(result.config);
  });
});
