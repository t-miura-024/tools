// Managed by chezmoi: tools/chezmoi/dot_config/opencode/lib/herdr-workspace-session.ts
//
// herdr-workspace-session プラグインの純粋ロジック。テスト可能にするため
// プラグイン本体（../plugins/herdr-workspace-session.ts）から分離している。
// このディレクトリは opencode のプラグイン自動検出対象外のため、
// 値エクスポートを含めてもローダーに誤って呼び出されることはない。

import { spawn } from "node:child_process";

export type SessionTime = {
  created: number;
  updated: number;
};

export type SessionInfo = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
  parentID?: string;
  time: SessionTime;
};

export type SessionProject = {
  id: string;
};

const SOURCE = "user:opencode-session";
const TOKEN = "agent_session";
const HERDR_ENV = "HERDR_ENV";
const HERDR_WORKSPACE_ID = "HERDR_WORKSPACE_ID";
const HERDR_BIN_PATH = "HERDR_BIN_PATH";
const HERDR_TIMEOUT_MS = 1_000;
const WARNING_DEDUP_MS = 30_000;

type SessionStatus = "busy" | "retry" | "idle";

export type RootSession = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
  parentID?: string;
  updatedAt: number;
  status?: SessionStatus;
  statusSequence: number;
};

export type HerdrRunResult = { ok: true } | { ok: false; error: string };

export type HerdrRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<HerdrRunResult>;

export type HerdrMetadataReporter = {
  set(value: string): Promise<void>;
  clear(): Promise<void>;
};

type QueueTask = () => Promise<void>;

function enqueue(queue: { current: Promise<void> }, task: QueueTask): Promise<void> {
  const next = queue.current.then(task, task);
  queue.current = next.catch(() => {});
  return next;
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]$/, "");
}

export function isRootSession(session: SessionInfo): boolean {
  return !session.parentID;
}

export function isCurrentProject(
  session: SessionInfo,
  project: SessionProject,
  directory: string,
): boolean {
  return (
    session.projectID === project.id &&
    normalizePath(session.directory) === normalizePath(directory)
  );
}

function statusKind(status: unknown): SessionStatus | undefined {
  const kind =
    typeof status === "string" ? status : (status as { type?: unknown } | undefined)?.type;
  if (kind === "busy" || kind === "retry") return kind;
  if (kind === "idle") return kind;
  return undefined;
}

function activityRank(status: SessionStatus | undefined): number {
  if (status === "busy" || status === "retry") return 2;
  if (status === "idle") return 1;
  return 0;
}

export function sessionDisplayValue(session: Pick<RootSession, "id" | "title">): string {
  return session.title.trim() || session.id;
}

export class SessionTracker {
  private readonly sessions = new Map<string, RootSession>();
  private sequence = 0;
  private primaryID: string | undefined;

  constructor(
    private readonly project: SessionProject,
    private readonly directory: string,
  ) {}

  seed(sessions: SessionInfo[]): void {
    for (const session of sessions) {
      if (!isRootSession(session) || !isCurrentProject(session, this.project, this.directory)) {
        continue;
      }
      this.sessions.set(session.id, this.toRootSession(session));
    }
    this.primaryID = this.latestByUpdatedAt()?.id;
  }

  addOrUpdate(session: SessionInfo): void {
    if (!isRootSession(session) || !isCurrentProject(session, this.project, this.directory)) {
      return;
    }

    const existing = this.sessions.get(session.id);
    this.sessions.set(session.id, {
      ...(existing ?? this.toRootSession(session)),
      ...this.toRootSession(session),
      status: existing?.status,
      statusSequence: existing?.statusSequence ?? 0,
    });
    if (!this.primaryID) this.primaryID = session.id;
  }

  updateStatus(sessionID: string, status: unknown): void {
    const session = this.sessions.get(sessionID);
    const nextStatus = statusKind(status);
    if (!session || !nextStatus) return;

    this.sequence += 1;
    session.status = nextStatus;
    session.statusSequence = this.sequence;
    this.primaryID = this.selectPrimary()?.id;
  }

  markIdle(sessionID: string): void {
    this.updateStatus(sessionID, "idle");
  }

  remove(session: SessionInfo): void {
    if (!isRootSession(session)) return;
    this.removeByID(session.id);
  }

  removeByID(sessionID: string): void {
    this.sessions.delete(sessionID);
    if (this.primaryID === sessionID) {
      this.primaryID = this.selectPrimary()?.id;
    }
  }

  current(): RootSession | undefined {
    return this.primaryID ? this.sessions.get(this.primaryID) : undefined;
  }

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  private toRootSession(session: SessionInfo): RootSession {
    return {
      id: session.id,
      title: session.title,
      directory: session.directory,
      projectID: session.projectID,
      parentID: session.parentID,
      updatedAt: session.time.updated,
      statusSequence: 0,
    };
  }

  private latestByUpdatedAt(): RootSession | undefined {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  private selectPrimary(): RootSession | undefined {
    return [...this.sessions.values()].sort((a, b) => {
      const rank = activityRank(b.status) - activityRank(a.status);
      if (rank !== 0) return rank;
      if (b.statusSequence !== a.statusSequence) return b.statusSequence - a.statusSequence;
      return b.updatedAt - a.updatedAt;
    })[0];
  }
}

export function runHerdr(
  binary: string,
  args: string[],
  timeoutMs = HERDR_TIMEOUT_MS,
): Promise<HerdrRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let child: ReturnType<typeof spawn>;

    const finish = (result: HerdrRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(binary, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, error: errorMessage(error) });
      return;
    }

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: errorMessage(error) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({
          ok: false,
          error: stderr.trim() || `exited with code ${code ?? "unknown"}`,
        });
      }
    });
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveHerdrBinary(
  environment: Record<string, string | undefined>,
): string | undefined {
  if (environment[HERDR_ENV] !== "1") return undefined;
  return environment[HERDR_BIN_PATH]?.trim() || "herdr";
}

function sessionArgs(workspaceID: string, value?: string): string[] {
  const args = ["workspace", "report-metadata", workspaceID, "--source", SOURCE];
  if (value === undefined) {
    args.push("--clear-token", TOKEN);
  } else {
    args.push("--token", `${TOKEN}=${value}`);
  }
  return args;
}

export function createHerdrMetadataReporter(options: {
  workspaceID: string;
  herdrBinary: string;
  runner?: HerdrRunner;
  onFailure?: (operation: string, error: string) => Promise<void>;
}): HerdrMetadataReporter {
  const runner = options.runner ?? runHerdr;
  const queue = { current: Promise.resolve() };
  const warningTimes = new Map<string, number>();

  function report(value: string | undefined): Promise<void> {
    return enqueue(queue, async () => {
      const operation =
        value === undefined ? "workspace metadata clear" : "workspace metadata update";
      const result = await runner(
        options.herdrBinary,
        sessionArgs(options.workspaceID, value),
        HERDR_TIMEOUT_MS,
      );
      if (result.ok || !options.onFailure) return;

      const now = Date.now();
      const key = `${operation}:${result.error}`;
      const previous = warningTimes.get(key);
      if (previous !== undefined && now - previous < WARNING_DEDUP_MS) return;
      warningTimes.set(key, now);
      await options.onFailure(operation, result.error);
    });
  }

  return {
    set: (value) => report(value),
    clear: () => report(undefined),
  };
}

export function sessionFromInfo(value: unknown): SessionInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const session = value as Partial<SessionInfo>;
  if (
    typeof session.id !== "string" ||
    typeof session.title !== "string" ||
    typeof session.directory !== "string" ||
    typeof session.projectID !== "string" ||
    typeof session.time?.updated !== "number"
  ) {
    return undefined;
  }
  return session as SessionInfo;
}

export function getWorkspaceID(
  environment: Record<string, string | undefined>,
): string | undefined {
  return environment[HERDR_WORKSPACE_ID]?.trim() || undefined;
}
