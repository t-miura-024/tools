import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildConfig,
  buildStatusOptionMap,
  defaultConfigPath,
  findStatusField,
  formatInitConfigResult,
  initConfig,
  InitConfigError,
  loadConfig,
  parseConfig,
  parseInitConfigCli,
  saveConfig,
  serializeConfig,
  type MtPlanConfig,
  type ProjectV2,
  type ProjectV2Field,
} from "./init-config";

function makeProject(
  fields: ProjectV2Field[],
  overrides: Partial<ProjectV2> = {},
): ProjectV2 {
  return {
    id: "PVT_test",
    number: 4,
    title: "plans",
    owner: { __typename: "User", login: "t-miura-024" },
    fields: { nodes: fields },
    ...overrides,
  };
}

function makeStatusField(
  overrides: Partial<{ id: string; name: string; options: Array<{ id: string; name: string }> }> = {},
): ProjectV2Field {
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

describe("mt-plan/init-config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-init-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("findStatusField", () => {
    it("Status 名の single select field を返す", () => {
      const fields: ProjectV2Field[] = [
        makeStatusField(),
        { id: "PVTF_other", name: "Assignees" },
      ];

      const result = findStatusField(fields);

      expect(result?.id).toBe("PVTF_status");
      expect(result?.name).toBe("Status");
    });

    it("Status field が見つからない場合は null を返す", () => {
      const fields: ProjectV2Field[] = [
        { id: "PVTF_other", name: "Assignees" },
      ];

      expect(findStatusField(fields)).toBeNull();
    });

    it("Status field が options を持たない場合は null を返す", () => {
      const fields: ProjectV2Field[] = [
        { id: "PVTF_status", name: "Status" },
      ];

      expect(findStatusField(fields)).toBeNull();
    });

    it("fieldName オプションで別名も検索できる", () => {
      const fields: ProjectV2Field[] = [
        makeStatusField({ name: "PlanStatus" }),
      ];

      const result = findStatusField(fields, "PlanStatus");

      expect(result?.name).toBe("PlanStatus");
    });
  });

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
      const project = makeProject([
        { id: "PVTF_other", name: "Assignees" },
      ]);

      expect(() => buildConfig(project)).toThrowError(InitConfigError);
      expect(() => buildConfig(project)).toThrowError(
        /does not have a 'Status' single select field/,
      );
    });
  });

  describe("serializeConfig / parseConfig", () => {
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

    it("serialize → parse でラウンドトリップできる", () => {
      const serialized = serializeConfig(sample);
      const parsed = parseConfig(serialized);

      expect(parsed).toEqual(sample);
    });

    it("不正な JSON はエラー", () => {
      expect(() => parseConfig("not json")).toThrowError(InitConfigError);
    });

    it("必須フィールドが欠けるとエラー", () => {
      expect(() => parseConfig('{"owner":"x"}')).toThrowError(
        /missing required field/,
      );
    });

    it("statusOptions に必要な status が欠けるとエラー", () => {
      const incomplete = JSON.stringify({
        owner: "x",
        projectNumber: 1,
        projectId: "PVT",
        statusFieldId: "F",
        statusOptions: { draft: "d", refined: "r", done: "dn" },
      });

      expect(() => parseConfig(incomplete)).toThrowError(
        /statusOptions\.in-progress/,
      );
    });
  });

  describe("saveConfig / loadConfig", () => {
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

    it("config ファイルが存在しない場合はエラー", () => {
      const missing = path.join(tmp, "missing.json");

      expect(() => loadConfig(missing)).toThrowError(InitConfigError);
      expect(() => loadConfig(missing)).toThrowError(/does not exist/);
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

  describe("parseInitConfigCli", () => {
    it("--config で config path を指定できる", () => {
      const options = parseInitConfigCli(["--config", "/tmp/config.json"]);

      expect(options.configPath).toBe("/tmp/config.json");
    });

    it("--help / -h で help フラグが立つ", () => {
      expect(parseInitConfigCli(["--help"]).help).toBe(true);
      expect(parseInitConfigCli(["-h"]).help).toBe(true);
    });

    it("未知の引数はエラー", () => {
      expect(() => parseInitConfigCli(["--unknown"])).toThrowError(InitConfigError);
    });

    it("--config に値がない場合はエラー", () => {
      expect(() => parseInitConfigCli(["--config"])).toThrowError(
        /--config requires/,
      );
    });
  });

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

  describe("defaultConfigPath", () => {
    it("$HOME/.config/mt-plan/config.json を返す", () => {
      const expected = path.join(os.homedir(), ".config", "mt-plan", "config.json");

      expect(defaultConfigPath()).toBe(expected);
    });
  });

  describe("initConfig (統合)", () => {
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
});
