import { describe, expect, test } from "bun:test";
import { translateEvent } from "../lib/herdr-agent-state-bridge";

describe("translateEvent", () => {
  test("passes session creation with parent info for child tracking", () => {
    expect(translateEvent({ type: "session.created", data: { sessionID: "s1" } })).toEqual({
      type: "session.created",
      properties: { sessionID: "s1", info: { id: "s1" } },
    });
    expect(
      translateEvent({ type: "session.created", data: { sessionID: "c1", parentID: "s1" } }),
    ).toEqual({
      type: "session.created",
      properties: { sessionID: "c1", info: { id: "c1", parentID: "s1" } },
    });
  });

  test("maps renames to session.updated", () => {
    expect(
      translateEvent({ type: "session.renamed", data: { sessionID: "s1", title: "x" } }),
    ).toEqual({
      type: "session.updated",
      properties: { sessionID: "s1", info: { id: "s1" } },
    });
  });

  test("passes status objects through", () => {
    const status = { type: "busy" };
    expect(translateEvent({ type: "session.status", data: { sessionID: "s1", status } })).toEqual({
      type: "session.status",
      properties: { sessionID: "s1", status },
    });
  });

  test("maps failure and idle to blocked/idle states", () => {
    expect(
      translateEvent({ type: "session.execution.failed", data: { sessionID: "s1", error: {} } }),
    ).toEqual({ type: "session.error", properties: { sessionID: "s1" } });
    expect(translateEvent({ type: "session.idle", data: { sessionID: "s1" } })).toEqual({
      type: "session.idle",
      properties: { sessionID: "s1" },
    });
  });

  test("maps permission and question flows", () => {
    expect(translateEvent({ type: "permission.asked", data: { sessionID: "s1" } })).toEqual({
      type: "permission.asked",
      properties: { sessionID: "s1" },
    });
    expect(translateEvent({ type: "permission.replied", data: { sessionID: "s1" } })).toEqual({
      type: "permission.replied",
      properties: { sessionID: "s1" },
    });
    expect(translateEvent({ type: "form.created", data: { sessionID: "s1" } })).toEqual({
      type: "question.asked",
      properties: { sessionID: "s1" },
    });
    expect(translateEvent({ type: "form.replied", data: { sessionID: "s1" } })).toEqual({
      type: "question.replied",
      properties: { sessionID: "s1" },
    });
    expect(translateEvent({ type: "form.cancelled", data: {} })).toEqual({
      type: "question.rejected",
      properties: { sessionID: undefined },
    });
  });

  test("maps compaction to working state", () => {
    expect(
      translateEvent({ type: "session.compaction.started", data: { sessionID: "s1" } }),
    ).toEqual({ type: "session.compacted", properties: { sessionID: "s1" } });
  });

  test("drops tool and text progress events handled by hooks", () => {
    expect(translateEvent({ type: "session.text.ended", data: { sessionID: "s1" } })).toBeNull();
    expect(translateEvent({ type: "session.tool.success", data: { sessionID: "s1" } })).toBeNull();
    expect(translateEvent({ type: "config.updated", data: {} })).toBeNull();
  });

  test("drops session events without an ID except child-state flows", () => {
    expect(translateEvent({ type: "session.created", data: {} })).toBeNull();
    expect(translateEvent({ type: "session.idle", data: {} })).toBeNull();
  });
});
