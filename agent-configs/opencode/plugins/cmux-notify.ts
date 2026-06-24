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

export const CmuxNotifyPlugin: Plugin = async () => {
  // Reflect "idle" state immediately on opencode startup. Fire-and-forget so
  // plugin initialization does not block the opencode boot path; ordering is
  // preserved by the shared queue, so any later event-driven updates will
  // observe a consistent state.
  enqueue(() => setCmuxStatus("Idle", "checkmark.circle.fill", COLOR_IDLE));
  enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.status") {
        const status = event.properties.status;
        if (status.type === "busy") {
          await enqueue(() => setCmuxStatus("Running", "bolt.fill", COLOR_RUNNING));
          await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_RUNNING));
        } else if (status.type === "retry") {
          await enqueue(() => setCmuxStatus("Retrying", "arrow.clockwise", COLOR_RETRY));
          await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_RETRY));
        } else if (status.type === "idle") {
          await enqueue(() => setCmuxStatus("Idle", "checkmark.circle.fill", COLOR_IDLE));
          await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));
        }
        return;
      }
      if (event.type === "session.idle") {
        await enqueue(() => setCmuxStatus("Idle", "checkmark.circle.fill", COLOR_IDLE));
        await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_IDLE));
        await notifyCmux(
          "Task complete",
          `Session ${event.properties.sessionID} is waiting for input`,
        );
        return;
      }
      if (event.type === "session.error") {
        await enqueue(() => setCmuxStatus("Error", "xmark.circle.fill", COLOR_ERROR));
        await enqueue(() => setWorkspaceColor(WORKSPACE_COLOR_ERROR));
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
      // Drop the status pill and clear the workspace color so the sidebar
      // returns to a neutral state after opencode exits.
      await enqueue(() => clearCmuxStatus());
      await enqueue(() => clearWorkspaceColor());
    },
  };
};

export default CmuxNotifyPlugin;
