import { describe, expect, test } from "bun:test";
import SessionNamer from "../plugins/mt-session-namer";
import { orderModelIDs } from "../lib/mt-session-namer";

function rootSession(title = "New session - 2026-08-10T00:00:00.000Z") {
  return {
    id: "root",
    title,
    directory: "/repo",
    projectID: "project-1",
  };
}

function provider(id: string, models: Record<string, unknown>) {
  return { id, models };
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
    let tempSequence = 0;
    const client = {
      app: { log: async () => {} },
      config: {
        providers: async () => ({
          data: {
            providers: [
              provider("provider-a", {
                expensive: { cost: { input: 1, output: 1 } },
                cheap: { cost: { input: 0.1, output: 1 } },
              }),
              provider("provider-b", {
                free: { cost: { input: 0, output: 0 } },
              }),
            ],
          },
        }),
      },
      session: {
        list: async () => ({ data: [] }),
        get: async () => ({ data: rootSession() }),
        messages: async () => ({
          data: [
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "Investigate the deployment issue" }],
            },
            {
              info: { role: "assistant", providerID: "provider-a" },
              parts: [{ type: "text", text: "I will inspect the deployment" }],
            },
          ],
        }),
        create: async () => ({ data: { id: `temp-${++tempSequence}` } }),
        prompt: async ({ body }: { body: { model: { providerID: string; modelID: string } } }) => {
          prompts.push(body.model);
          if (body.model.modelID === "cheap") {
            throw new Error("rate limit");
          }
          return { data: { parts: [{ type: "text", text: "Deployment issue" }] } };
        },
        delete: async () => {},
        update: async ({ body }: { body: { title: string } }) => {
          updates.push(body.title);
        },
      },
    } as any;

    const plugin = await SessionNamer({
      client,
      project: { id: "project-1", worktree: "/repo", time: { created: 1 } },
      directory: "/repo",
    } as any);

    await plugin.event?.({
      event: { type: "session.created", properties: { info: rootSession() } },
    });
    await plugin.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "root", text: "response" },
        },
      },
    });

    expect(prompts).toEqual([
      { providerID: "provider-a", modelID: "cheap" },
      { providerID: "provider-a", modelID: "expensive" },
    ]);
    expect(updates).toEqual(["Deployment issue"]);
  });
});
