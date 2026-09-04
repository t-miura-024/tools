// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/herdr-workspace-session.ts
//
// Mirrors the active OpenCode root session into a Herdr workspace metadata token.
//
// NOTE: このファイルは default エクスポート（Plugin.define の結果）のみを持つこと。
// opencode のローダーはこの形式を要求し、他の値エクスポートがあると
// ロード全体が失敗する。純粋ロジックは ../lib/herdr-workspace-session.ts に置く。
//
// V2 制約: プラグイン API に session.list がないため、起動時の既存セッションは
// シードできない。ロード後に届くイベントから追跡を開始する。
import { Plugin } from "@opencode-ai/plugin";
import {
  createHerdrMetadataReporter,
  errorMessage,
  getWorkspaceID,
  isCurrentProject,
  isRootSession,
  resolveHerdrBinary,
  sessionDisplayValue,
  SessionTracker,
  type SessionInfo,
} from "../lib/herdr-workspace-session";

type SessionClient = Plugin.Context["session"];

type SessionDetails = {
  id: string;
  title?: string;
  projectID: string;
  parentID?: string;
  location: { directory: string };
  time: { created: number; updated: number };
};

function toSessionInfo(details: SessionDetails): SessionInfo {
  return {
    id: details.id,
    title: details.title ?? details.id,
    directory: details.location.directory,
    projectID: details.projectID,
    parentID: details.parentID,
    time: { created: details.time.created, updated: details.time.updated },
  };
}

export default Plugin.define({
  id: "mt-herdr-workspace-session",
  setup(ctx) {
    const environment = process.env;
    const workspaceID = getWorkspaceID(environment);
    const herdrBinary = resolveHerdrBinary(environment);
    if (!workspaceID || !herdrBinary) {
      return;
    }

    const project = { id: ctx.location.project.id };
    const directory = ctx.location.directory;
    const tracker = new SessionTracker(project, directory);
    const queue = { current: Promise.resolve() };

    function enqueue(task: () => Promise<void>): Promise<void> {
      const next = queue.current.then(task, task);
      queue.current = next.catch(() => {});
      return next;
    }

    async function warn(operation: string, error: string): Promise<void> {
      try {
        console.warn(`[herdr-workspace-session] Herdr ${operation} failed: ${error}`);
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

    function isCurrent(info: SessionInfo): boolean {
      return isRootSession(info) && isCurrentProject(info, project, directory);
    }

    async function trackSession(session: SessionClient, sessionID: string): Promise<boolean> {
      if (tracker.has(sessionID)) return true;
      try {
        const details = (await session.get({ sessionID })) as unknown as SessionDetails;
        const info = toSessionInfo(details);
        if (!isCurrent(info)) return false;
        tracker.addOrUpdate(info);
        return tracker.has(sessionID);
      } catch (error) {
        await warn("session lookup", errorMessage(error));
        return false;
      }
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await enqueue(async () => {
            try {
              switch (event.type) {
                case "session.created": {
                  if (event.data.parentID) break;
                  if (await trackSession(ctx.session, event.data.sessionID)) {
                    await publish();
                  }
                  break;
                }
                case "session.renamed": {
                  if (!tracker.has(event.data.sessionID)) break;
                  try {
                    const details = (await ctx.session.get({
                      sessionID: event.data.sessionID,
                    })) as unknown as SessionDetails;
                    const info = toSessionInfo(details);
                    if (!isCurrent(info)) {
                      tracker.removeByID(info.id);
                    } else {
                      tracker.addOrUpdate(info);
                    }
                    await publish();
                  } catch (error) {
                    await warn("session lookup", errorMessage(error));
                  }
                  break;
                }
                case "session.status": {
                  if (await trackSession(ctx.session, event.data.sessionID)) {
                    tracker.updateStatus(event.data.sessionID, event.data.status);
                    await publish();
                  }
                  break;
                }
                case "session.idle": {
                  if (await trackSession(ctx.session, event.data.sessionID)) {
                    tracker.markIdle(event.data.sessionID);
                    await publish();
                  }
                  break;
                }
                case "session.deleted": {
                  if (tracker.has(event.data.sessionID)) {
                    tracker.removeByID(event.data.sessionID);
                    await publish();
                  }
                  break;
                }
                default:
                  break;
              }
            } catch (error) {
              await warn("event handling", errorMessage(error));
            }
          });
        }
      } catch {
        // Aborted on dispose; nothing to report.
      }
    })();

    return () => {
      controller.abort();
      void enqueue(async () => {
        await reporter.clear();
      });
    };
  },
});
