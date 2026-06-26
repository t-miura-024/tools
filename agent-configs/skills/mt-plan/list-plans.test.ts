import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractPlanStatus,
  filterAndSort,
  formatListPlansResult,
  listPlans,
  ListPlansError,
  parseListPlansCli,
  sortByCreatedAtDesc,
  usage,
  type ListedPlan,
  type ProjectItem,
} from "./list-plans";
import {
  InitConfigError,
  loadConfig,
  saveConfig,
  type MtPlanConfig,
} from "./init-config";

function makeConfig(
  overrides: Partial<MtPlanConfig> = {},
): MtPlanConfig {
  return {
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
    ...overrides,
  };
}

function makeItem(
  overrides: Partial<{
    itemId: string;
    number: number;
    title: string;
    state: "OPEN" | "CLOSED";
    createdAt: string;
    optionId: string | null;
  }> = {},
): ProjectItem {
  const optionId = overrides.optionId ?? null;
  return {
    id: overrides.itemId ?? "PVTI_test",
    issue: {
      number: overrides.number ?? 1,
      title: overrides.title ?? "Test Plan",
      url: `https://github.com/t-miura-024/tools/issues/${overrides.number ?? 1}`,
      state: overrides.state ?? "OPEN",
      createdAt: overrides.createdAt ?? "2026-06-25T10:00:00Z",
    },
    fieldValueByName: {
      Status: {
        name: "draft",
        optionId,
      },
    },
  };
}

describe("mt-plan/list-plans (Project version)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-list-plans-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("extractPlanStatus", () => {
    it("optionId から status を逆引きする", () => {
      const config = makeConfig();
      const item = makeItem({ optionId: "opt_refined" });

      expect(extractPlanStatus(item, config)).toBe("refined");
    });

    it("Status field がない場合は null", () => {
      const config = makeConfig();
      const item: ProjectItem = {
        id: "PVTI_x",
        issue: {
          number: 1,
          title: "x",
          url: "u",
          state: "OPEN",
          createdAt: "2026-06-25T10:00:00Z",
        },
      };

      expect(extractPlanStatus(item, config)).toBeNull();
    });

    it("optionId が null の場合は null", () => {
      const config = makeConfig();
      const item = makeItem({ optionId: null });

      expect(extractPlanStatus(item, config)).toBeNull();
    });

    it("未知の optionId の場合は null", () => {
      const config = makeConfig();
      const item = makeItem({ optionId: "opt_unknown" });

      expect(extractPlanStatus(item, config)).toBeNull();
    });
  });

  describe("filterAndSort", () => {
    it("指定された status の plan だけを残し、createdAt desc に sort", () => {
      const config = makeConfig();
      const items: ProjectItem[] = [
        makeItem({ itemId: "i1", number: 1, title: "old", createdAt: "2026-06-20T00:00:00Z", optionId: "opt_refined" }),
        makeItem({ itemId: "i2", number: 2, title: "new", createdAt: "2026-06-25T00:00:00Z", optionId: "opt_refined" }),
        makeItem({ itemId: "i3", number: 3, title: "draft", createdAt: "2026-06-22T00:00:00Z", optionId: "opt_draft" }),
      ];

      const result = filterAndSort(items, config, ["refined"]);

      expect(result.map((p) => p.itemId)).toEqual(["i2", "i1"]);
    });

    it("複数の status を指定できる", () => {
      const config = makeConfig();
      const items: ProjectItem[] = [
        makeItem({ itemId: "i1", number: 1, optionId: "opt_refined" }),
        makeItem({ itemId: "i2", number: 2, optionId: "opt_in_progress" }),
        makeItem({ itemId: "i3", number: 3, optionId: "opt_draft" }),
        makeItem({ itemId: "i4", number: 4, optionId: "opt_done" }),
      ];

      const result = filterAndSort(items, config, ["refined", "in-progress"]);

      expect(result.map((p) => p.itemId).sort()).toEqual(["i1", "i2"]);
    });
  });

  describe("sortByCreatedAtDesc", () => {
    it("createdAt の降順で sort する", () => {
      const plans: ListedPlan[] = [
        { itemId: "a", number: 1, title: "a", url: "u", status: "refined", state: "OPEN", createdAt: "2026-06-20T00:00:00Z" },
        { itemId: "b", number: 2, title: "b", url: "u", status: "refined", state: "OPEN", createdAt: "2026-06-25T00:00:00Z" },
        { itemId: "c", number: 3, title: "c", url: "u", status: "refined", state: "OPEN", createdAt: "2026-06-22T00:00:00Z" },
      ];

      const sorted = sortByCreatedAtDesc(plans);

      expect(sorted.map((p) => p.itemId)).toEqual(["b", "c", "a"]);
    });
  });

  describe("formatListPlansResult", () => {
    it("plan がない場合は空メッセージ", () => {
      const config = makeConfig();
      const output = formatListPlansResult({ config, statuses: ["refined"], plans: [] });

      expect(output).toContain("plans: none");
    });

    it("[status] title (#number) YYYY-MM-DD 形式で表示", () => {
      const config = makeConfig();
      const result = {
        config,
        statuses: ["refined", "in-progress"] as const,
        plans: [
          { itemId: "i1", number: 123, title: "サンプル計画", url: "u", status: "refined" as const, state: "OPEN" as const, createdAt: "2026-06-25T10:00:00Z" },
        ],
      };

      const output = formatListPlansResult(result);

      expect(output).toContain("1. [refined] サンプル計画 (#123) 2026-06-25");
    });
  });

  describe("parseListPlansCli", () => {
    it("デフォルトの status は空 (呼び出し側で補完)", () => {
      const options = parseListPlansCli([]);
      expect(options.statuses).toEqual([]);
    });

    it("status を positional で複数指定できる", () => {
      const options = parseListPlansCli(["refined", "in-progress"]);
      expect(options.statuses).toEqual(["refined", "in-progress"]);
    });

    it("--config で config path を指定できる", () => {
      const options = parseListPlansCli(["--config", "/tmp/c.json", "refined"]);
      expect(options.configPath).toBe("/tmp/c.json");
      expect(options.statuses).toEqual(["refined"]);
    });

    it("--help / -h で help フラグ", () => {
      expect(parseListPlansCli(["--help"]).help).toBe(true);
      expect(parseListPlansCli(["-h"]).help).toBe(true);
    });

    it("未対応 status はエラー", () => {
      expect(() => parseListPlansCli(["archived"])).toThrowError(ListPlansError);
    });
  });

  describe("usage", () => {
    it("usage メッセージを返す", () => {
      const text = usage();
      expect(text).toContain("Usage:");
      expect(text).toContain("refined");
      expect(text).toContain("in-progress");
    });
  });

  describe("listPlans (mock 経由)", () => {
    it("mock fetchItems で filter + sort まで実行", async () => {
      const config = makeConfig();
      const mockItems: ProjectItem[] = [
        makeItem({ itemId: "i1", number: 1, createdAt: "2026-06-25T00:00:00Z", optionId: "opt_refined" }),
        makeItem({ itemId: "i2", number: 2, createdAt: "2026-06-20T00:00:00Z", optionId: "opt_in_progress" }),
        makeItem({ itemId: "i3", number: 3, createdAt: "2026-06-22T00:00:00Z", optionId: "opt_draft" }),
      ];

      const result = await listPlans({
        config,
        statuses: ["refined", "in-progress"],
        fetchItems: async () => mockItems,
      });

      expect(result.plans.map((p) => p.itemId)).toEqual(["i1", "i2"]);
    });

    it("statuses を省略すると refined / in-progress がデフォルト", async () => {
      const config = makeConfig();
      const mockItems: ProjectItem[] = [
        makeItem({ itemId: "i1", optionId: "opt_refined" }),
        makeItem({ itemId: "i2", optionId: "opt_done" }),
        makeItem({ itemId: "i3", optionId: "opt_draft" }),
      ];

      const result = await listPlans({
        config,
        fetchItems: async () => mockItems,
      });

      expect(result.statuses).toEqual(["refined", "in-progress"]);
      expect(result.plans.map((p) => p.itemId)).toEqual(["i1"]);
    });
  });

  describe("loadConfig / saveConfig 統合", () => {
    it("config をファイル経由で読み込んで listPlans に渡せる", async () => {
      const config = makeConfig();
      const configPath = path.join(tmp, "config.json");
      saveConfig(config, configPath);

      const loaded = loadConfig(configPath);
      const mockItems: ProjectItem[] = [
        makeItem({ itemId: "i1", optionId: "opt_refined" }),
      ];

      const result = await listPlans({
        config: loaded,
        fetchItems: async () => mockItems,
      });

      expect(result.plans).toHaveLength(1);
    });

    it("config が存在しない場合は InitConfigError", () => {
      expect(() => loadConfig(path.join(tmp, "missing.json"))).toThrowError(
        InitConfigError,
      );
    });
  });
});
