// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/cursor-hook-bridge.ts
// Source of Truth: tools/chezmoi/dot_config/opencode/plugins/agent-hooks/block-cursor-config-direct-edit.ts
//
// Cursor の hooks.json 形式を opencode の plugin 形式に bridge する。
// tool.execute.before で HANDLERS の command を spawn して結果 JSON を解釈する。
import { spawnSync } from "node:child_process";
import * as path from "node:path";

type HookDefinition = {
  command: string;
  matcher?: string;
};

type HookOutcome = {
  permission?: "allow" | "deny";
  agent_message?: string;
  user_message?: string;
};

const HANDLERS: Record<string, HookDefinition[]> = {
  "tool.execute.before": [
    {"command":"bun \"$HOME/.config/opencode/plugins/agent-hooks/block-cursor-config-direct-edit.ts\"","matcher":"^(write|edit|Write|Edit|StrReplace|MultiEdit|Delete|EditNotebook)$"},
  ],
};

function rewriteCommand(command: string): string {
  const pluginDir = path.dirname(new URL(import.meta.url).pathname);
  return command
    .replace(/\$HOME\/\.cursor\/scripts\/agent-hooks\//g, `${pluginDir}/agent-hooks/`)
    .replace(/\.config\/opencode\/plugins\/agent-hooks\//g, `${pluginDir}/agent-hooks/`)
    .replace(/"/g, "");
}

function evaluateHook(definition: HookDefinition, toolName: string, input: unknown): HookOutcome {
  if (definition.matcher && !new RegExp(definition.matcher).test(toolName)) {
    return { permission: "allow" };
  }
  const command = rewriteCommand(definition.command);
  const [bin, ...args] = command.split(/\s+/);
  const res = spawnSync(bin, args, { input: JSON.stringify(input), encoding: "utf8" });
  if (res.status !== 0) return { permission: "allow" };
  try {
    return JSON.parse(res.stdout) as HookOutcome;
  } catch {
    return { permission: "allow" };
  }
}

export default async function plugin() {
  return {
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => {
      for (const definition of HANDLERS["tool.execute.before"] ?? []) {
        const hookInput = { tool: input.tool, args: output.args };
        const outcome = evaluateHook(definition, input.tool, hookInput);
        if (outcome.permission === "deny") {
          throw new Error(outcome.user_message ?? outcome.agent_message ?? "blocked by hook");
        }
      }
    },
    "tool.execute.after": async (input: { tool: string; args: unknown }) => {
      for (const definition of HANDLERS["tool.execute.after"] ?? []) {
        evaluateHook(definition, input.tool, input);
      }
    },
  };
}
