// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/cursor-hook-bridge.ts
//
// Cursor の hooks.json 形式を opencode の plugin 形式に bridge する。
// tool.execute hook で HANDLERS の command を spawn して結果 JSON を解釈する。
//
// 動作保証: OpenCode のみ（下記 HANDLERS の command が参照する agent-hooks スクリプトは
// OpenCode 経由で実機検証済み。Cursor / Claude Code 経由は未検証）。
//
// NOTE: このファイルは default エクスポート（Plugin.define の結果）のみを持つこと。
// opencode のローダーはこの形式を要求し、他の値エクスポートがあると
// ロード全体が失敗する。
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { Plugin } from "@opencode-ai/plugin";

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

export default Plugin.define({
  id: "mt-cursor-hook-bridge",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      for (const definition of HANDLERS["tool.execute.before"] ?? []) {
        const hookInput = { tool: event.tool, args: event.input };
        const outcome = evaluateHook(definition, event.tool, hookInput);
        if (outcome.permission === "deny") {
          throw new Error(outcome.user_message ?? outcome.agent_message ?? "blocked by hook");
        }
      }
    });
    await ctx.tool.hook("execute.after", async (event) => {
      for (const definition of HANDLERS["tool.execute.after"] ?? []) {
        evaluateHook(definition, event.tool, { tool: event.tool, args: event.input });
      }
    });
  },
});
