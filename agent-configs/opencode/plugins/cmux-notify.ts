// Source of Truth: agent-configs/opencode/plugins/cmux-notify.ts
// Synced to ~/.config/opencode/plugins/cmux-notify.ts by `mt agent-config sync`.
// Do not edit the deployed copy directly; edit the Source of Truth and re-sync.

import { spawn } from "node:child_process";
import type { Event } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";

const TITLE = "OpenCode";
const STATUS_KEY = "agent_status";

const COLOR_RUNNING = "#4C8DFF";
const COLOR_RETRY = "#FFA500";
const COLOR_ERROR = "#FF3B30";

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

function summarizeError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.name === "string") return obj.name;
  }
  return fallback;
}

export const CmuxNotifyPlugin: Plugin = async () => {
  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.status") {
        const status = event.properties.status;
        if (status.type === "busy") {
          await enqueue(() => setCmuxStatus("Running", "bolt.fill", COLOR_RUNNING));
        } else if (status.type === "retry") {
          await enqueue(() =>
            setCmuxStatus("Retrying", "arrow.clockwise", COLOR_RETRY),
          );
        } else if (status.type === "idle") {
          await enqueue(() => clearCmuxStatus());
        }
        return;
      }
      if (event.type === "session.idle") {
        await enqueue(() => clearCmuxStatus());
        await notifyCmux(
          "Task complete",
          `Session ${event.properties.sessionID} is waiting for input`,
        );
        return;
      }
      if (event.type === "session.error") {
        await enqueue(() => setCmuxStatus("Error", "xmark.circle.fill", COLOR_ERROR));
        const session = event.properties.sessionID ?? "unknown";
        const detail = summarizeError(
          event.properties.error,
          "see opencode logs",
        );
        await notifyCmux("Error", `Session ${session} failed: ${detail}`);
        return;
      }
      if (event.type === "permission.updated") {
        const perm = event.properties;
        await notifyCmux(
          "Waiting for input",
          `Permission needed: ${perm.title} (${perm.sessionID})`,
        );
        return;
      }
    },
    dispose: async () => {
      await enqueue(() => clearCmuxStatus());
    },
  };
};

export default CmuxNotifyPlugin;
