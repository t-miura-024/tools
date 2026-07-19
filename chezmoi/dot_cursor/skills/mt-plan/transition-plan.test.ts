import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendHistoryEntry,
  formatTransitionResult,
  parseTransitionPlanCli,
  transitionPlan,
  TransitionPlanError,
  usage,
  type UpdateIssueBodyFn,
  type UpdateIssueStateFn,
  type UpdateItemStatusFn,
  type FindPlanItemFn,
} from "./transition-plan";
import {
  InitConfigError,
  loadConfig,
  saveConfig,
  type MtPlanConfig,
  type PlanStatus,
} from "./init-config";

function makeConfig(): MtPlanConfig {
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
  };
}

describe("mt-plan/transition-plan (Project version)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-transition-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("appendHistoryEntry", () => {
    it("## 🐢 履歴 セクションがない場合は末尾に追加", () => {
      const body = "## 💭 背景\n\nこれはテストです。";
      const result = appendHistoryEntry(body, "draft", "refined");

      expect(result).toContain("## 🐢 履歴");
      expect(result).toContain("[refined] draft から遷移");
    });

    it("## 🐢 履歴 セクションがある場合はその直下に追記", () => {
      const body = "## 💭 背景\n\nこれはテストです。\n\n## 🐢 履歴\n\n- 2026-06-25 10:00 [refined] previous";
      const result = appendHistoryEntry(body, "refined", "in-progress");

      expect(result).toContain("## 🐢 履歴");
      expect(result).toContain("- 2026-06-25 10:00 [refined] previous");
      expect(result).toContain("[in-progress] refined から遷移");
    });

    it("## 🐢 履歴 セクションが空の場合はその直下に追記 (新セクションを作らない)", () => {
      const body = "## 💭 背景\n\nこれはテストです。\n\n## 🐢 履歴";
      const result = appendHistoryEntry(body, "draft", "refined");

      const matches = result.match(/## 🐢 履歴/g);
      expect(matches?.length).toBe(1);
      expect(result).toContain("[refined] draft から遷移");
    });

    it("## 🐢 履歴 ヘッダーのみで末尾にある場合もその直下に追記", () => {
      const body = "## 💭 背景\n\n## 🐢 履歴\n";
      const result = appendHistoryEntry(body, "draft", "refined");

      const matches = result.match(/## 🐢 履歴/g);
      expect(matches?.length).toBe(1);
      expect(result).toContain("[refined] draft から遷移");
    });

    it("## 🐢 履歴 が body 中盤にあって、後に別セクションがある場合も追記できる", () => {
      const body = [
        "## 💭 背景",
        "",
        "これはテストです。",
        "",
        "## 🐢 履歴",
        "",
        "- 2026-06-25 10:00 [refined] previous",
        "",
        "## 🦊 別セクション",
        "",
        "別のセクションの内容",
      ].join("\n");
      const result = appendHistoryEntry(body, "refined", "in-progress");

      const matches = result.match(/## 🐢 履歴/g);
      expect(matches?.length).toBe(1);
      expect(result).toContain("- 2026-06-25 10:00 [refined] previous");
      expect(result).toContain("[in-progress] refined から遷移");
      expect(result).toContain("## 🦊 別セクション");
      expect(result).toContain("別のセクションの内容");

      const historyIdx = result.indexOf("## 🐢 履歴");
      const otherIdx = result.indexOf("## 🦊 別セクション");
      expect(historyIdx).toBeLessThan(otherIdx);

      const newEntryIdx = result.indexOf("[in-progress] refined から遷移");
      const oldEntryIdx = result.indexOf("[refined] previous");
      expect(newEntryIdx).toBeLessThan(oldEntryIdx);
    });

    it("## 🐢 履歴 が body 中盤にあり、内容が空で、後に別セクションがある場合は追記できる", () => {
      const body = [
        "## 💭 背景",
        "",
        "これはテストです。",
        "",
        "## 🐢 履歴",
        "",
        "## 🦊 別セクション",
        "",
        "別のセクションの内容",
      ].join("\n");
      const result = appendHistoryEntry(body, "draft", "refined");

      const matches = result.match(/## 🐢 履歴/g);
      expect(matches?.length).toBe(1);
      expect(result).toContain("[refined] draft から遷移");
      expect(result).toContain("## 🦊 別セクション");
    });
    it("executionTransition=true で UUID マーカーが埋め込まれる", () => {
      const body = "## 🐢 履歴\n";
      const result = appendHistoryEntry(body, "refined", "in-progress", true, "550e8400-e29b-41d4-a716-446655440000");
      expect(result).toContain("(mt-run-plan)");
      expect(result).toContain("<!-- mt-run-plan-marker: 550e8400-e29b-41d4-a716-446655440000 -->");
    });

    it("executionTransition=false でマーカーも (mt-run-plan) も付かない", () => {
      const body = "## 🐢 履歴\n";
      const result = appendHistoryEntry(body, "draft", "refined", false, null);
      expect(result).not.toContain("(mt-run-plan)");
      expect(result).not.toContain("mt-run-plan-marker");
    });

    it("executionTransition=true だが executionMarker が null ならマーカーなし", () => {
      const body = "## 🐢 履歴\n";
      const result = appendHistoryEntry(body, "refined", "in-progress", true, null);
      expect(result).toContain("(mt-run-plan)");
      expect(result).not.toContain("mt-run-plan-marker");
    });
  });

  describe("parseTransitionPlanCli", () => {
    it("number と target status を positional で受け取る", () => {
      const options = parseTransitionPlanCli(["7", "in-progress"]);
      expect(options.number).toBe(7);
      expect(options.targetStatus).toBe("in-progress");
    });

    it("--config で config path を指定できる", () => {
      const options = parseTransitionPlanCli(["7", "in-progress", "--config", "/tmp/c.json"]);
      expect(options.configPath).toBe("/tmp/c.json");
    });

    it("--help / -h", () => {
      expect(parseTransitionPlanCli(["--help"]).help).toBe(true);
      expect(parseTransitionPlanCli(["-h"]).help).toBe(true);
    });

    it("number が数値以外ならエラー", () => {
      expect(() => parseTransitionPlanCli(["abc", "in-progress"])).toThrowError(
        TransitionPlanError,
      );
    });

    it("未対応 status はエラー", () => {
      expect(() => parseTransitionPlanCli(["7", "archived"])).toThrowError(
        TransitionPlanError,
      );
    });

    it("引数が多すぎる場合はエラー", () => {
      expect(() => parseTransitionPlanCli(["7", "in-progress", "extra"])).toThrowError(
        TransitionPlanError,
      );
    });
  });

  describe("usage", () => {
    it("usage メッセージを返す", () => {
      const text = usage();
      expect(text).toContain("Usage:");
      expect(text).toContain("Supported statuses");
    });
  });

  describe("transitionPlan (mock 経由)", () => {
    const findPlanItem: FindPlanItemFn = async () => ({
      itemId: "PVTI_abc",
      currentStatus: "draft",
      repo: "t-miura-024/tools",
    });

    it("draft → refined の遷移を実行し、status / issue state / body を更新", async () => {
      const config = makeConfig();
      const statusUpdates: Array<{ itemId: string; optionId: string }> = [];
      const stateUpdates: Array<{ state: "open" | "closed" }> = [];
      const bodyUpdates: string[] = [];

      const updateItemStatus: UpdateItemStatusFn = async (params) => {
        statusUpdates.push({ itemId: params.itemId, optionId: params.optionId });
      };
      const updateIssueState: UpdateIssueStateFn = async (params) => {
        stateUpdates.push({ state: params.state });
      };
      const readIssueBody = async () => "## 💭 背景\n\n元の body";
      const updateIssueBody: UpdateIssueBodyFn = async (params) => {
        bodyUpdates.push(params.body);
      };

      const result = await transitionPlan({
        config,
        number: 7,
        targetStatus: "refined",
        findPlanItem,
        updateItemStatus,
        updateIssueState,
        readIssueBody,
        updateIssueBody,
        getParentIssueNumber: async () => null,
        listSubIssueNumbers: async () => [],
      });

      expect(statusUpdates).toEqual([
        { itemId: "PVTI_abc", optionId: config.statusOptions.refined },
      ]);
      expect(stateUpdates).toEqual([{ state: "open" }]);
      expect(bodyUpdates).toHaveLength(1);
      expect(bodyUpdates[0]).toContain("[refined] draft から遷移");
      expect(result.sourceStatus).toBe("draft");
      expect(result.targetStatus).toBe("refined");
      expect(result.bodyUpdated).toBe(true);
      expect(result.issueStateChanged).toBe(true);
      expect(result.issueClosed).toBe(false);
    });

    it("in-progress → done では Issue を close する", async () => {
      const config = makeConfig();
      const stateUpdates: Array<{ state: "open" | "closed" }> = [];

      await transitionPlan({
        config,
        number: 7,
        targetStatus: "done",
        findPlanItem: async () => ({
          itemId: "PVTI_abc",
          currentStatus: "in-progress",
          repo: "t-miura-024/tools",
        }),
        updateItemStatus: async () => undefined,
        updateIssueState: async (params) => {
          stateUpdates.push({ state: params.state });
        },
        readIssueBody: async () => "",
        updateIssueBody: async () => undefined,
        getParentIssueNumber: async () => null,
        listSubIssueNumbers: async () => [],
      });

      expect(stateUpdates).toEqual([{ state: "closed" }]);
    });

    it("同じ status への遷移はエラー", async () => {
      const config = makeConfig();

      await expect(
        transitionPlan({
          config,
          number: 7,
          targetStatus: "refined",
          findPlanItem: async () => ({
            itemId: "PVTI_abc",
            currentStatus: "refined",
            repo: "t-miura-024/tools",
          }),
          updateItemStatus: async () => undefined,
          updateIssueState: async () => undefined,
          readIssueBody: async () => "",
          updateIssueBody: async () => undefined,
          getParentIssueNumber: async () => null,
          listSubIssueNumbers: async () => [],
        }),
      ).rejects.toThrowError(/already in status/);
    });

    it("skipHistoryAppend = true で body 更新をスキップ", async () => {
      const config = makeConfig();
      const bodyUpdates: string[] = [];

      const result = await transitionPlan({
        config,
        number: 7,
        targetStatus: "refined",
        findPlanItem,
        updateItemStatus: async () => undefined,
        updateIssueState: async () => undefined,
        readIssueBody: async () => "",
        updateIssueBody: async (params) => {
          bodyUpdates.push(params.body);
        },
        skipHistoryAppend: true,
        getParentIssueNumber: async () => null,
        listSubIssueNumbers: async () => [],
      });

      expect(bodyUpdates).toHaveLength(0);
      expect(result.bodyUpdated).toBe(false);
    });

    it("親計画の in-progress 遷移を拒否する", async () => {
      const config = makeConfig();

      await expect(
        transitionPlan({
          config,
          number: 10,
          targetStatus: "in-progress",
          findPlanItem: async () => ({
            itemId: "PVTI_parent",
            currentStatus: "refined",
            repo: "t-miura-024/tools",
          }),
          updateItemStatus: async () => undefined,
          updateIssueState: async () => undefined,
          readIssueBody: async () => "",
          updateIssueBody: async () => undefined,
          getParentIssueNumber: async () => null,
          listSubIssueNumbers: async () => [11],
        }),
      ).rejects.toThrowError(/parent plan/);
    });

    it("親計画の done 遷移を拒否する", async () => {
      const config = makeConfig();

      await expect(
        transitionPlan({
          config,
          number: 10,
          targetStatus: "done",
          findPlanItem: async () => ({
            itemId: "PVTI_parent",
            currentStatus: "in-progress",
            repo: "t-miura-024/tools",
          }),
          updateItemStatus: async () => undefined,
          updateIssueState: async () => undefined,
          readIssueBody: async () => "",
          updateIssueBody: async () => undefined,
          getParentIssueNumber: async () => null,
          listSubIssueNumbers: async () => [11],
        }),
      ).rejects.toThrowError(/parent plan/);
    });

    it("最初の子計画の in-progress 遷移で親を in-progress に集約する", async () => {
      const config = makeConfig();
      const statuses = new Map<number, "refined" | "in-progress" | "done">([
        [10, "refined"],
        [11, "refined"],
        [12, "refined"],
      ]);
      const statusUpdates: Array<{ itemId: string; optionId: string }> = [];
      const bodies = new Map<number, string>();
      let parentFindCount = 0;

      const result = await transitionPlan({
        config,
        number: 11,
        targetStatus: "in-progress",
        findPlanItem: async ({ number }) => {
          if (number === 10) {
            parentFindCount += 1;
            return {
              itemId: "PVTI_10",
              currentStatus: parentFindCount === 1 ? "refined" : (statuses.get(10)!),
              repo: "t-miura-024/tools",
            };
          }
          return {
            itemId: `PVTI_${number}`,
            currentStatus: statuses.get(number)!,
            repo: "t-miura-024/tools",
          };
        },
        updateItemStatus: async ({ itemId, optionId }) => {
          statusUpdates.push({ itemId, optionId });
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as "refined" | "in-progress" | "done");
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11, 12] : [],
      });

      expect(result.parentTransition).toMatchObject({
        number: 10,
        sourceStatus: "refined",
        targetStatus: "in-progress",
      });
      expect(statusUpdates).toEqual([
        { itemId: "PVTI_11", optionId: config.statusOptions["in-progress"] },
        { itemId: "PVTI_10", optionId: config.statusOptions["in-progress"] },
      ]);
      const childBody = bodies.get(11)!;
      expect(childBody).toContain("(mt-run-plan)");
      expect(childBody).toMatch(/<!-- mt-run-plan-marker: [a-f0-9-]+ -->/);
    });

    it("最後の子計画の done 遷移で親を done に集約する", async () => {
      const config = makeConfig();
      const statuses = new Map<number, "in-progress" | "done">([
        [10, "in-progress"],
        [11, "done"],
        [12, "in-progress"],
      ]);
      const bodies = new Map<number, string>([
        [11, "## 🐢 履歴\n- 2026-07-15 02:00 [done] in-progress から遷移 (mt-run-plan) <!-- mt-run-plan-marker: 550e8400-e29b-41d4-a716-446655440000 -->"],
      ]);
      let parentFindCount = 0;

      const result = await transitionPlan({
        config,
        number: 12,
        targetStatus: "done",
        findPlanItem: async ({ number }) => {
          if (number === 10) {
            parentFindCount += 1;
            return {
              itemId: "PVTI_10",
              currentStatus: parentFindCount === 1 ? "in-progress" : (statuses.get(10)!),
              repo: "t-miura-024/tools",
            };
          }
          return {
            itemId: `PVTI_${number}`,
            currentStatus: statuses.get(number)!,
            repo: "t-miura-024/tools",
          };
        },
        updateItemStatus: async ({ itemId, optionId }) => {
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as "in-progress" | "done");
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11, 12] : [],
      });

      expect(result.parentTransition).toMatchObject({
        number: 10,
        sourceStatus: "in-progress",
        targetStatus: "done",
        issueClosed: true,
      });
      const childBody = bodies.get(12)!;
      expect(childBody).toMatch(/<!-- mt-run-plan-marker: [a-f0-9-]+ -->/);
    });

    it("兄弟の body にマーカーがない場合、親 done 集約しない", async () => {
      const config = makeConfig();
      const statuses = new Map<number, "in-progress" | "done">([
        [10, "in-progress"],
        [11, "done"],
        [12, "in-progress"],
      ]);
      const bodies = new Map<number, string>();
      let parentFindCount = 0;

      const result = await transitionPlan({
        config,
        number: 12,
        targetStatus: "done",
        findPlanItem: async ({ number }) => {
          if (number === 10) {
            parentFindCount += 1;
            return {
              itemId: "PVTI_10",
              currentStatus: parentFindCount === 1 ? "in-progress" : (statuses.get(10)!),
              repo: "t-miura-024/tools",
            };
          }
          return {
            itemId: `PVTI_${number}`,
            currentStatus: statuses.get(number)!,
            repo: "t-miura-024/tools",
          };
        },
        updateItemStatus: async ({ itemId, optionId }) => {
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as "in-progress" | "done");
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11, 12] : [],
      });

      expect(result.parentTransition).toBeUndefined();
    });

    it("既にin-progressの親に2番目の子が遷移しても親を重複集約しない", async () => {
      const config = makeConfig();
      const statuses = new Map<number, "refined" | "in-progress">([
        [10, "in-progress"],
        [11, "in-progress"],
        [12, "refined"],
      ]);
      const bodies = new Map<number, string>([
        [11, "## 🐢 履歴\n- 2026-07-15 02:00 [in-progress] refined から遷移 (mt-run-plan) <!-- mt-run-plan-marker: 550e8400-e29b-41d4-a716-446655440000 -->"],
      ]);
      let parentFindCount = 0;

      const result = await transitionPlan({
        config,
        number: 12,
        targetStatus: "in-progress",
        findPlanItem: async ({ number }) => {
          if (number === 10) {
            parentFindCount += 1;
            return {
              itemId: "PVTI_10",
              currentStatus: parentFindCount === 1 ? "in-progress" : (statuses.get(10)!),
              repo: "t-miura-024/tools",
            };
          }
          return {
            itemId: `PVTI_${number}`,
            currentStatus: statuses.get(number)!,
            repo: "t-miura-024/tools",
          };
        },
        updateItemStatus: async ({ itemId, optionId }) => {
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as "refined" | "in-progress");
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11, 12] : [],
      });

      expect(result.parentTransition).toBeUndefined();
    });

    it("一部の子だけdoneで残りがin-progressの場合、親done集約しない", async () => {
      const config = makeConfig();
      const statuses = new Map<number, "in-progress" | "done">([
        [10, "in-progress"],
        [11, "done"],
        [12, "in-progress"],
        [13, "in-progress"],
      ]);
      const bodies = new Map<number, string>([
        [11, "## 🐢 履歴\n- 2026-07-15 02:00 [done] in-progress から遷移 (mt-run-plan) <!-- mt-run-plan-marker: 550e8400-e29b-41d4-a716-446655440000 -->"],
      ]);
      let parentFindCount = 0;

      const result = await transitionPlan({
        config,
        number: 13,
        targetStatus: "done",
        findPlanItem: async ({ number }) => {
          if (number === 10) {
            parentFindCount += 1;
            return {
              itemId: "PVTI_10",
              currentStatus: parentFindCount === 1 ? "in-progress" : (statuses.get(10)!),
              repo: "t-miura-024/tools",
            };
          }
          return {
            itemId: `PVTI_${number}`,
            currentStatus: statuses.get(number)!,
            repo: "t-miura-024/tools",
          };
        },
        updateItemStatus: async ({ itemId, optionId }) => {
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as "in-progress" | "done");
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11, 12, 13] : [],
      });

      expect(result.parentTransition).toBeUndefined();
    });

    it("refined遷移は親集約をトリガーしない", async () => {
      const config = makeConfig();
      const statuses = new Map<number, PlanStatus>([
        [10, "draft"],
        [11, "draft"],
      ]);
      const bodies = new Map<number, string>();

      const result = await transitionPlan({
        config,
        number: 11,
        targetStatus: "refined",
        findPlanItem: async ({ number }) => ({
          itemId: `PVTI_${number}`,
          currentStatus: statuses.get(number)!,
          repo: "t-miura-024/tools",
        }),
        updateItemStatus: async ({ itemId, optionId }) => {
          const number = Number(itemId.replace("PVTI_", ""));
          const status = Object.entries(config.statusOptions).find(([, id]) => id === optionId)?.[0];
          statuses.set(number, status as PlanStatus);
        },
        updateIssueState: async () => undefined,
        readIssueBody: async ({ number }) => bodies.get(number) ?? "",
        updateIssueBody: async ({ number, body }) => {
          bodies.set(number, body);
        },
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async ({ number }) => number === 10 ? [11] : [],
      });

      expect(result.parentTransition).toBeUndefined();
      const childBody = bodies.get(11)!;
      expect(childBody).not.toContain("(mt-run-plan)");
      expect(childBody).not.toContain("mt-run-plan-marker");
    });

    it("parentNumberがnullならparentTransitionはundefined", async () => {
      const config = makeConfig();

      const result = await transitionPlan({
        config,
        number: 7,
        targetStatus: "in-progress",
        findPlanItem: async () => ({
          itemId: "PVTI_abc",
          currentStatus: "refined",
          repo: "t-miura-024/tools",
        }),
        updateItemStatus: async () => undefined,
        updateIssueState: async () => undefined,
        readIssueBody: async () => "",
        updateIssueBody: async () => undefined,
        getParentIssueNumber: async () => null,
        listSubIssueNumbers: async () => [],
      });

      expect(result.parentTransition).toBeUndefined();
    });

    it("subIssueNumbersが空ならparentTransitionはundefined", async () => {
      const config = makeConfig();

      const result = await transitionPlan({
        config,
        number: 7,
        targetStatus: "in-progress",
        findPlanItem: async () => ({
          itemId: "PVTI_abc",
          currentStatus: "refined",
          repo: "t-miura-024/tools",
        }),
        updateItemStatus: async () => undefined,
        updateIssueState: async () => undefined,
        readIssueBody: async () => "",
        updateIssueBody: async () => undefined,
        getParentIssueNumber: async () => 10,
        listSubIssueNumbers: async () => [],
      });

      expect(result.parentTransition).toBeUndefined();
    });
  });

  describe("formatTransitionResult", () => {
    it("result の主要フィールドを表示する", () => {
      const result = {
        itemId: "PVTI_abc",
        number: 7,
        sourceStatus: "refined" as const,
        targetStatus: "in-progress" as const,
        bodyUpdated: true,
        issueStateChanged: true,
        issueClosed: false,
      };
      const output = formatTransitionResult(result);

      expect(output).toContain("number: #7");
      expect(output).toContain("status: refined -> in-progress");
      expect(output).toContain("item: PVTI_abc");
      expect(output).toContain("history: appended");
      expect(output).toContain("issue: reopened");
    });

    it("done への遷移は issue: closed と表示", () => {
      const result = {
        itemId: "PVTI_abc",
        number: 7,
        sourceStatus: "in-progress" as const,
        targetStatus: "done" as const,
        bodyUpdated: true,
        issueStateChanged: true,
        issueClosed: true,
      };
      const output = formatTransitionResult(result);

      expect(output).toContain("issue: closed");
    });
  });

  describe("loadConfig 統合", () => {
    it("config をファイルから読み込める", () => {
      const config = makeConfig();
      const configPath = path.join(tmp, "config.json");
      saveConfig(config, configPath);

      const loaded = loadConfig(configPath);

      expect(loaded).toEqual(config);
    });

    it("存在しない config はエラー", () => {
      expect(() => loadConfig(path.join(tmp, "missing.json"))).toThrowError(
        InitConfigError,
      );
    });
  });
});
