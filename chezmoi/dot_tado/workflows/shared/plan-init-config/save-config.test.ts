import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveConfig } from "./save-config";
import { loadConfig } from "./load-config";
import type { MtPlanConfig } from "./types";

describe("saveConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-init-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("config をファイルに保存して読み込める", () => {
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

  it("保存先ディレクトリが存在しない場合は作成する", () => {
    const nested = path.join(tmp, "nested", "dir", "config.json");
    const config: MtPlanConfig = {
      owner: "t-miura-024",
      projectNumber: 4,
      projectId: "PVT_test",
      statusFieldId: "PVTF_status",
      statusOptions: {
        draft: "d",
        refined: "r",
        "in-progress": "ip",
        done: "dn",
      },
    };

    saveConfig(config, nested);

    expect(fs.existsSync(nested)).toBe(true);
  });
});
