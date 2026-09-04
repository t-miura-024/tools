// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/herdr-workspace-session.ts
//
// Mirrors the active OpenCode root session into a Herdr workspace metadata token.
//
// NOTE: このファイルは default エクスポートのみを持つこと。opencode のローダーは
// モジュールの全エクスポートをプラグイン関数として呼び出すため、値の名前付き
// エクスポート（特に class）があるとロード全体が失敗する。純粋ロジックは
// ../lib/herdr-workspace-session.ts に置き、テストはそちらを参照する。
import type { Event } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";
import {
  createHerdrMetadataReporter,
  errorMessage,
  getWorkspaceID,
  isCurrentProject,
  isRootSession,
  resolveHerdrBinary,
  sessionDisplayValue,
  sessionFromInfo,
  SessionTracker,
} from "../lib/herdr-workspace-session";

const HerdrWorkspaceSessionPlugin: Plugin = async ({ client, project, directory }) => {
  const environment = process.env;
  const workspaceID = getWorkspaceID(environment);
  const herdrBinary = resolveHerdrBinary(environment);
  if (!workspaceID || !herdrBinary) {
    return {};
  }

  const tracker = new SessionTracker(project, directory);
  const queue = { current: Promise.resolve() };

  function enqueue(queue: { current: Promise<void> }, task: () => Promise<void>): Promise<void> {
    const next = queue.current.then(task, task);
    queue.current = next.catch(() => {});
    return next;
  }

  async function warn(operation: string, error: string): Promise<void> {
    try {
      await client.app.log({
        body: {
          service: "herdr-workspace-session",
          level: "warn",
          message: `Herdr ${operation} failed: ${error}`,
        },
      });
    } catch {
      // Logging must never affect the OpenCode event loop.
    }
  }

  const reporter = createHerdrMetadataReporter({
    workspaceID,
    herdrBinary,
    onFailure: warn,
  });

  async function publish(): Promise<void> {
    const value = tracker.current();
    if (value) {
      await reporter.set(sessionDisplayValue(value));
    } else {
      await reporter.clear();
    }
  }

  async function loadSessions(): Promise<void> {
    try {
      const response = await client.session.list();
      tracker.seed(
        (response.data ?? []).filter((session) => {
          return isRootSession(session) && isCurrentProject(session, project, directory);
        }),
      );
      await publish();
    } catch (error) {
      await warn("session list", errorMessage(error));
    }
  }

  async function ensureTrackedRootSession(sessionID: string): Promise<boolean> {
    if (tracker.has(sessionID)) return true;

    try {
      const response = await client.session.get({ path: { id: sessionID } });
      const session = response.data;
      if (!session || session.parentID || !isCurrentProject(session, project, directory)) {
        return false;
      }
      tracker.addOrUpdate(session);
      return tracker.has(sessionID);
    } catch (error) {
      await warn("session lookup", errorMessage(error));
      return false;
    }
  }

  async function handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const session = sessionFromInfo(event.properties.info);
        if (session?.parentID) return;
        if (session) {
          tracker.addOrUpdate(session);
          await publish();
        }
        return;
      }
      case "session.status": {
        const sessionID = event.properties.sessionID;
        if (await ensureTrackedRootSession(sessionID)) {
          tracker.updateStatus(sessionID, event.properties.status);
          await publish();
        }
        return;
      }
      case "session.idle":
        if (await ensureTrackedRootSession(event.properties.sessionID)) {
          tracker.markIdle(event.properties.sessionID);
          await publish();
        }
        return;
      case "session.deleted": {
        const session = sessionFromInfo(event.properties.info);
        if (session) {
          tracker.remove(session);
          await publish();
        }
        return;
      }
      default:
        return;
    }
  }

  enqueue(queue, loadSessions);

  return {
    event: async ({ event }: { event: Event }) => {
      await enqueue(queue, async () => {
        try {
          await handleEvent(event);
        } catch (error) {
          await warn("event handling", errorMessage(error));
        }
      });
    },
    dispose: async () => {
      await enqueue(queue, async () => {
        await reporter.clear();
      });
    },
  };
};

export default HerdrWorkspaceSessionPlugin;
