import { describe, expect, mock, test } from "bun:test";

mock.module("@opencode-ai/plugin", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));

import { orderModelIDs } from "../lib/mt-session-namer";

type SessionNamerPlugin = {
  id: string;
  setup: (ctx: any) => (() => void) | void;
};

async function loadPlugin(): Promise<SessionNamerPlugin> {
  const mod = await import("../plugins/mt-session-namer");
  return mod.default as unknown as SessionNamerPlugin;
}

function rootSession(title = "New session - 2026-08-10T00:00:00.000Z") {
  return {
    id: "root",
    title,
    projectID: "project-1",
    location: { directory: "/repo" },
    time: { created: 1, updated: 1 },
  };
}

function provider(id: string, models: Record<string, unknown>) {
  return { id, models };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("session namer model selection", () => {
  test("orders models by input cost and leaves unknown prices last", () => {
    expect(
      orderModelIDs({
        expensive: { cost: { input: 1, output: 1 } },
        cheap: { cost: { input: 0.1, output: 5 } },
        tieBreaker: { cost: { input: 0.1, output: 1 } },
        unknown: {},
      } as any),
    ).toEqual(["tieBreaker", "cheap", "expensive", "unknown"]);
  });

  test("falls back within the main session provider only", async () => {
    const prompts: Array<{ providerID: string; modelID: string }> = [];
    const updates: string[] = [];
    const hooks: Record<string, (event: any) => void> = {};
    const context = {
      location: { directory: "/repo", project: { id: "project-1" } },
      catalog: {
        provider: {
          list: async () => ({
            data: [
              provider("provider-a", {
                expensive: { cost: { input: 1, output: 1 } },
                cheap: { cost: { input: 0.1, output: 1 } },
              }),
              provider("provider-b", {
                free: { cost: { input: 0, output: 0 } },
              }),
            ],
          }),
        },
      },
      session: {
        get: async () => rootSession(),
        context: async () => [
          { type: "user", text: "Investigate the deployment issue" },
          {
            type: "assistant",
            model: { providerID: "provider-a" },
            content: [{ type: "text", text: "I will inspect the deployment" }],
          },
        ],
        rename: async ({ title }: { title: string }) => {
          updates.push(title);
        },
        hook: async (name: string, callback: (event: any) => void) => {
          hooks[name] = callback;
          return { dispose: async () => {} };
        },
      },
      generate: {
        text: async ({ model }: { model: { providerID: string; id: string } }) => {
          prompts.push({ providerID: model.providerID, modelID: model.id });
          if (model.id === "cheap") {
            throw new Error("rate limit");
          }
          return { text: "Deployment issue" };
        },
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    } as any;

    const plugin = await loadPlugin();
    expect(plugin.id).toBe("mt-session-namer");
    plugin.setup(context);
    await flush();

    hooks["prompt"]({ sessionID: "root" });
    await flush();

    expect(prompts).toEqual([
      { providerID: "provider-a", modelID: "cheap" },
      { providerID: "provider-a", modelID: "expensive" },
    ]);
    expect(updates).toEqual(["Deployment issue"]);
  });
});
