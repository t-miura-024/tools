import { describe, expect, test } from "bun:test";
import {
  createHerdrMetadataReporter,
  SessionTracker,
  sessionDisplayValue,
  type HerdrRunResult,
  type RootSession,
} from "../plugins/herdr-workspace-session";

const project = {
  id: "project-1",
  worktree: "/repo",
  time: { created: 1 },
};

function session(
  id: string,
  updated: number,
  title = id,
  parentID?: string,
): RootSession {
  return {
    id,
    title,
    directory: "/repo",
    projectID: project.id,
    parentID,
    updatedAt: updated,
    statusSequence: 0,
  };
}

function info(value: RootSession) {
  return {
    id: value.id,
    title: value.title,
    directory: value.directory,
    projectID: value.projectID,
    parentID: value.parentID,
    time: { created: 1, updated: value.updatedAt },
  };
}

describe("SessionTracker", () => {
  test("falls back to the full session ID when the title is blank", () => {
    expect(sessionDisplayValue(session("ses_123", 1, "  "))).toBe("ses_123");
    expect(sessionDisplayValue(session("ses_123", 1, "Review auth"))).toBe(
      "Review auth",
    );
  });

  test("seeds the newest root session and ignores child sessions", () => {
    const tracker = new SessionTracker(project, "/repo");
    tracker.seed([
      info(session("old", 1)),
      info(session("new", 2)),
      info(session("child", 3, "child", "new")),
    ]);

    expect(tracker.current()?.id).toBe("new");
  });

  test("prefers busy and retry sessions over idle sessions", () => {
    const tracker = new SessionTracker(project, "/repo");
    tracker.seed([info(session("idle", 3)), info(session("busy", 1))]);

    tracker.updateStatus("idle", "idle");
    tracker.updateStatus("busy", "busy");
    expect(tracker.current()?.id).toBe("busy");

    tracker.updateStatus("busy", "retry");
    expect(tracker.current()?.id).toBe("busy");
  });

  test("does not switch primary on a title update", () => {
    const tracker = new SessionTracker(project, "/repo");
    tracker.seed([info(session("first", 2)), info(session("second", 1))]);
    tracker.updateStatus("first", "idle");
    tracker.updateStatus("second", "idle");
    expect(tracker.current()?.id).toBe("second");

    tracker.addOrUpdate(info(session("first", 4, "new title")));
    expect(tracker.current()?.id).toBe("second");
  });

  test("hands off to the next candidate after deleting primary", () => {
    const tracker = new SessionTracker(project, "/repo");
    tracker.seed([info(session("first", 2)), info(session("second", 1))]);
    tracker.remove(info(session("first", 2)));

    expect(tracker.current()?.id).toBe("second");
  });
});

describe("Herdr invocation seam", () => {
  test("a fake runner can inspect metadata and clear argv", async () => {
    const calls: Array<{ binary: string; args: string[]; timeout: number }> =
      [];
    const runner = async (
      binary: string,
      args: string[],
      timeout: number,
    ): Promise<HerdrRunResult> => {
      calls.push({ binary, args, timeout });
      return { ok: true };
    };

    const reporter = createHerdrMetadataReporter({
      workspaceID: "w1",
      herdrBinary: "/bin/herdr",
      runner,
    });
    await reporter.set("Review auth");
    await reporter.clear();

    expect(calls).toEqual([
      {
        binary: "/bin/herdr",
        args: [
          "workspace",
          "report-metadata",
          "w1",
          "--source",
          "user:opencode-session",
          "--token",
          "agent_session=Review auth",
        ],
        timeout: 1_000,
      },
      {
        binary: "/bin/herdr",
        args: [
          "workspace",
          "report-metadata",
          "w1",
          "--source",
          "user:opencode-session",
          "--clear-token",
          "agent_session",
        ],
        timeout: 1_000,
      },
    ]);
  });

  test("continues queued updates after a failed Herdr call", async () => {
    const results: HerdrRunResult[] = [
      { ok: false, error: "connection refused" },
      { ok: true },
    ];
    const calls: string[][] = [];
    const reporter = createHerdrMetadataReporter({
      workspaceID: "w1",
      herdrBinary: "/bin/herdr",
      runner: async (_binary, args) => {
        calls.push(args);
        return results.shift() ?? { ok: true };
      },
    });

    await reporter.set("first");
    await reporter.clear();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--clear-token");
  });
});
