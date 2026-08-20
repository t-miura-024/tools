// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/cursor-hook-bridge.ts
// Source of Truth: tools/chezmoi/dot_config/opencode/plugins/agent-hooks/block-chezmoi-direct-edit.ts
//
// Cursor の hooks.json 形式を opencode の plugin 形式に bridge する。
// tool.execute.before で HANDLERS の command を spawn して結果 JSON を解釈する。
//
// 動作保証: OpenCode のみ（下記 HANDLERS の command が参照する agent-hooks スクリプトは
// OpenCode 経由で実機検証済み。Cursor / Claude Code 経由は未検証）。
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
    {
      command: 'bun "$HOME/.config/opencode/plugins/agent-hooks/block-chezmoi-direct-edit.ts"',
      matcher: "^(write|edit|Write|Edit|StrReplace|MultiEdit|Delete|EditNotebook)$",
    },
  ],
};

function rewriteCommand(command: string): string[] {
  const pluginDir = path.dirname(new URL(import.meta.url).pathname);
  const home = process.env.HOME ?? "";
  // `$HOME` を解決し、ハーネスの配置ディレクトリをプラグインの実ディレクトリに合わせる。
  const resolved = command
    .replace(/\$HOME\/\.cursor\/scripts\/agent-hooks\//g, `${pluginDir}/agent-hooks/`)
    .replace(/\$HOME\/\.config\/opencode\/plugins\/agent-hooks\//g, `${pluginDir}/agent-hooks/`)
    .replace(/\$HOME\//g, `${home}/`);
  // ダブルクォートを除去してから空白で tokenize する。
  return resolved.replace(/"/g, "").split(/\s+/).filter(Boolean);
}

function evaluateHook(definition: HookDefinition, toolName: string, input: unknown): HookOutcome {
  if (definition.matcher && !new RegExp(definition.matcher).test(toolName)) {
    return { permission: "allow" };
  }
  const args = rewriteCommand(definition.command);
  const [bin, ...rest] = args;
  const res = spawnSync(bin, rest, { input: JSON.stringify(input), encoding: "utf8" });
  if (res.status !== 0) return { permission: "allow" };
  try {
    return JSON.parse(res.stdout) as HookOutcome;
  } catch {
    return { permission: "allow" };
  }
}

export default async function plugin() {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown },
    ) => {
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
