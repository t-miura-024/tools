import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./load-config";
import { saveConfig } from "./save-config";
import { InitConfigError } from "./init-config-error";
import type { MtPlanConfig } from "./types";

describe("loadConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-init-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("config をファイルから読み込める", () => {
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
    const configPath = path.join(tmp, "config.json");
    saveConfig(config, configPath);

    const loaded = loadConfig(configPath);

    expect(loaded).toEqual(config);
  });

  it("config ファイルが存在しない場合はエラー", () => {
    const missing = path.join(tmp, "missing.json");

    expect(() => loadConfig(missing)).toThrowError(InitConfigError);
    expect(() => loadConfig(missing)).toThrowError(/does not exist/);
  });
});
