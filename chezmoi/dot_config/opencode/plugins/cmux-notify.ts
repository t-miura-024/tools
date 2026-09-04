// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/cmux-notify.ts
//
// opencode のセッション状態変化を cmux に通知し、サイドバータブに status バッジを出す。
// `cmux` バイナリが PATH にない場合は no-op で安全（クラッシュしない）。
//
// NOTE: このファイルは default エクスポート（Plugin.define の結果）のみを持つこと。
// opencode のローダーはこの形式を要求し、他の値エクスポートがあると
// ロード全体が失敗する。

import { spawn } from "node:child_process";
import { Plugin } from "@opencode-ai/plugin";

const TITLE = "OpenCode";
const STATUS_KEY = "agent_status";

const COLOR_RUNNING = "#4C8DFF";
const COLOR_RETRY = "#FFA500";
const COLOR_ERROR = "#FF3B30";
const COLOR_IDLE = "#2ECC71";

const WORKSPACE_COLOR_RUNNING = "Blue";
const WORKSPACE_COLOR_RETRY = "Orange";
const WORKSPACE_COLOR_ERROR = "Red";
const WORKSPACE_COLOR_IDLE = "Green";

let queue: Promise<void> = Promise.resolve();

function workspaceFlag(): string[] {
  const workspaceId = process.env.CMUX_WORKSPACE_ID?.trim();
  return workspaceId ? ["--workspace", workspaceId] : [];
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function runCmux(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("cmux", args, { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

function notifyCmux(subtitle: string, body: string): Promise<void> {
  return runCmux([
    "notify",
    "--title",
    TITLE,
    "--subtitle",
    subtitle,
    "--body",
    body,
    ...workspaceFlag(),
  ]);
}

function setCmuxStatus(label: string, icon: string, color: string): Promise<void> {
  return runCmux([
    "set-status",
    STATUS_KEY,
    label,
    "--icon",
    icon,
    "--color",
    color,
    ...workspaceFlag(),
  ]);
}

function clearCmuxStatus(): Promise<void> {
  return runCmux(["clear-status", STATUS_KEY, ...workspaceFlag()]);
}

function computeGitShortstat(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["diff", "--shortstat"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolve(null));
      child.on("exit", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        const insMatch = text.match(/(\d+) insertions?\(\+\)/);
        const delMatch = text.match(/(\d+) deletions?\(-\)/);
        const insertions = insMatch ? insMatch[1] : "0";
        const deletions = delMatch ? delMatch[1] : "0";
        resolve(`(+${insertions} -${deletions})`);
      });
    } catch {
      resolve(null);
    }
  });
}

async function setStatusWithDiff(label: string, icon: string, color: string): Promise<void> {
  const diff = await computeGitShortstat();
  const fullLabel = diff ? `${label} ${diff}` : label;
  await setCmuxStatus(fullLabel, icon, color);
}

function setWorkspaceColor(color: string): Promise<void> {
  return runCmux([
    "workspace-action",
    "--action",
    "set-color",
    "--color",
    color,
    ...workspaceFlag(),
  ]);
}

function clearWorkspaceColor(): Promise<void> {
  return runCmux(["workspace-action", "--action", "clear-color", ...workspaceFlag()]);
}

function summarizeError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.name === "string") return obj.name;
  }
  return fallback;
}

async function isMainSession(
  session: Plugin.Context["session"],
  sessionID: string,
): Promise<boolean> {
  try {
    const info = await session.get({ sessionID });
    return !info.parentID;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "mt-cmux-notify",
  setup(ctx) {
    // Reflect "idle" state immediately on opencode startup. Fire-and-forget so
    // plugin initialization does not block the opencode boot path; ordering is
    // preserved by the shared queue, so any later event-driven updates will
    // observe a consistent state.
    enqueue(() => setStatusWithDiff("Idle", "checkmark.circle.fill", COLOR_IDLE));
    enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          switch (event.type) {
            case "session.status": {
              const status = event.data.status.type;
              if (status === "busy") {
                await enqueue(() => setStatusWithDiff("Running", "bolt.fill", COLOR_RUNNING));
                await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_RUNNING));
              } else if (status === "retry") {
                await enqueue(() => setStatusWithDiff("Retrying", "arrow.clockwise", COLOR_RETRY));
                await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_RETRY));
              } else if (status === "idle") {
                await enqueue(() => setStatusWithDiff("Idle", "checkmark.circle.fill", COLOR_IDLE));
                await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));
              }
              break;
            }
            case "session.idle": {
              const sessionID = event.data.sessionID;
              await enqueue(() => setStatusWithDiff("Idle", "checkmark.circle.fill", COLOR_IDLE));
              await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));
              if (await isMainSession(ctx.session, sessionID)) {
                await notifyCmux("Task complete", `Session ${sessionID} is waiting for input`);
              }
              break;
            }
            case "session.execution.failed": {
              await enqueue(() => setStatusWithDiff("Error", "xmark.circle.fill", COLOR_ERROR));
              await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_ERROR));
              const sessionID = event.data.sessionID;
              if (sessionID && (await isMainSession(ctx.session, sessionID))) {
                const detail = summarizeError(event.data.error, "see opencode logs");
                await notifyCmux("Error", `Session ${sessionID} failed: ${detail}`);
              }
              break;
            }
            case "permission.asked": {
              const perm = event.data;
              if (await isMainSession(ctx.session, perm.sessionID)) {
                const target = [perm.action, ...perm.resources].filter(Boolean).join(" ");
                await notifyCmux(
                  "Waiting for input",
                  `Permission needed: ${target} (${perm.sessionID})`,
                );
              }
              break;
            }
            default:
              break;
          }
        }
      } catch {
        // Aborted on dispose; nothing to report.
      }
    })();

    return () => {
      controller.abort();
      // Drop the status pill and clear the workspace color so the sidebar
      // returns to a neutral state after opencode exits.
      void enqueue(() => clearCmuxStatus());
      void enqueue(() => clearWorkspaceColor());
    };
  },
});
