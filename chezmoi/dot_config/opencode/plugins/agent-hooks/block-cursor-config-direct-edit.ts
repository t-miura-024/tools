#!/usr/bin/env bun
/**
 * ユーザーレベルの preToolUse hook。
 * 3 つの「直接編集禁止」領域への編集をブロックし、編集者を canonical Source of Truth に誘導する。
 *
 * 保護対象（deny）:
 *   - Deployed 側: `~/.cursor/{agents,skills,commands,rules}/`, `~/.claude/{agents,skills}/`,
 *     `~/.config/opencode/{agents,skills,plugins,commands}/`
 *   - Non-canonical source 側: `tools/chezmoi/dot_claude/`, `tools/chezmoi/dot_config/opencode/`
 * 許可（allow）:
 *   - Canonical source: `tools/chezmoi/dot_cursor/`
 *
 * 配置場所:
 *   `chezmoi/dot_config/opencode/plugins/agent-hooks/block-cursor-config-direct-edit.ts` から
 *   `chezmoi apply` 経由で `~/.config/opencode/plugins/agent-hooks/` にデプロイされ、
 *   3 つの platform 設定ファイル（`~/.cursor/hooks.json` /
 *   `~/.claude/settings.json` / `cursor-hook-bridge.ts`）から共通参照される。
 *
 * 自己完結性:
 *   単一ファイルで配布されるため、外部モジュールの import を禁止する（テスト以外）。
 */

import * as fs from "node:fs";

/** 保護対象のサブディレクトリ。複数ルートの各々に対してチェックされる。 */
const PROTECTED_DIRS = ["skills", "rules", "commands", "agents"] as const;

/** Canonical Source of Truth（chezmoi source 内）。deployed と 3 つの source 宛先は deny される。 */
const CANONICAL_SOURCE_ROOT = "tools/chezmoi/dot_cursor";

export interface ExtractedPaths {
  toolName: string;
  path1: string;
  path2: string;
}

/**
 * Cursor / OpenCode / Claude Code から渡される tool use イベント JSON から、
 * 判定に必要なフィールドを defensive に抽出する。
 *
 * Cursor 形式: { tool_name, tool_input: { file_path, path, target_notebook } }
 * OpenCode 形式: { tool, args: { filePath, path, targetNotebook } }
 * 型が想定と違うフィールドは無視する。
 */
export function extractPaths(input: unknown): ExtractedPaths {
  if (typeof input !== "object" || input === null) {
    return { toolName: "", path1: "", path2: "" };
  }
  const root = input as Record<string, unknown>;

  // toolName: Cursor は tool_name、OpenCode は tool
  let toolName = typeof root.tool_name === "string" ? root.tool_name : "";
  if (!toolName && typeof root.tool === "string") {
    toolName = root.tool;
  }

  // toolInput: Cursor は tool_input、OpenCode は args
  const toolInput =
    typeof root.tool_input === "object" && root.tool_input !== null
      ? (root.tool_input as Record<string, unknown>)
      : typeof root.args === "object" && root.args !== null
        ? (root.args as Record<string, unknown>)
        : {};

  // path1: Cursor は file_path ＞ path、OpenCode は filePath ＞ path
  const path1 =
    typeof toolInput.file_path === "string"
      ? toolInput.file_path
      : typeof toolInput.filePath === "string"
        ? toolInput.filePath
        : typeof toolInput.path === "string"
          ? toolInput.path
          : "";

  // path2: Cursor は target_notebook、OpenCode は targetNotebook
  const path2 =
    typeof toolInput.target_notebook === "string"
      ? toolInput.target_notebook
      : typeof toolInput.targetNotebook === "string"
        ? toolInput.targetNotebook
        : "";
  return { toolName, path1, path2 };
}

/**
 * `~` / 相対パス / 絶対パスの 3 パターンを絶対パス表記に正規化する。
 * 空文字列はそのまま空文字列を返す。
 */
export function normalizePath(
  p: string,
  home: string,
  cwd: string,
): string {
  if (!p) return "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  if (p.startsWith("/")) return p;
  return `${cwd}/${p}`;
}

/**
 * 絶対パスが保護対象ルート群のいずれかの配下の
 * `skills/` / `rules/` / `commands/` / `agents/` に該当するか判定する。
 * 類似名（例: `skills_x/`）はマッチしない。
 */
export function isProtected(
  absPath: string,
  protectedRoots: readonly string[],
): boolean {
  if (!absPath) return false;
  for (const root of protectedRoots) {
    for (const dir of PROTECTED_DIRS) {
      if (absPath.startsWith(`${root}/${dir}/`)) return true;
    }
  }
  return false;
}

export interface HookResponse {
  permission: "allow" | "deny";
  agent_message?: string;
  user_message?: string;
}

export interface ResponseConfig {
  levelLabel: string;
  sourceRoot: string;
  destRoot: string;
  syncDescription: string;
  manualSync: string;
}

const CURSOR_USER_RESPONSE: ResponseConfig = {
  levelLabel: "user-level",
  sourceRoot: "tools/chezmoi/dot_cursor/",
  destRoot: "~/.cursor/",
  syncDescription: "chezmoi apply (via 'mt chezmoi apply')",
  manualSync: "`mt chezmoi apply`",
};

const OPENCODE_USER_RESPONSE: ResponseConfig = {
  levelLabel: "user-level",
  sourceRoot: "tools/chezmoi/dot_cursor/",
  destRoot: "~/.config/opencode/",
  syncDescription: "chezmoi apply (via 'mt chezmoi apply')",
  manualSync: "`mt chezmoi apply`",
};

const CLAUDE_USER_RESPONSE: ResponseConfig = {
  levelLabel: "user-level Claude Code",
  sourceRoot: "tools/chezmoi/dot_cursor/",
  destRoot: "~/.claude/",
  syncDescription: "chezmoi apply (via 'mt chezmoi apply')",
  manualSync: "`mt chezmoi apply`",
};

const CLAUDE_PROJECT_RESPONSE: ResponseConfig = {
  levelLabel: "project-level Claude Code",
  sourceRoot: "tools/chezmoi/dot_cursor/",
  destRoot: ".claude/",
  syncDescription: "chezmoi apply (via 'mt chezmoi apply')",
  manualSync: "`mt chezmoi apply`",
};

/**
 * 3 つの deployed ルート + 2 つの non-canonical source ルートを構築する。
 * canonical（`tools/chezmoi/dot_cursor/`）は allow するため含めない。
 *
 * tools ルートは `~/src/tools/chezmoi/dot_*` を直接指す。
 * ユーザー環境によって配置場所が違う場合は `CHEZMOI_SOURCE_DIR` 環境変数で上書き可能。
 */
export function buildProtectedRoots(home: string, toolsRoot: string): string[] {
  const chezmoiBase = `${toolsRoot}/chezmoi`;
  return [
    `${home}/.cursor`,
    `${home}/.claude`,
    `${home}/.config/opencode`,
    `${chezmoiBase}/dot_claude`,
    `${chezmoiBase}/dot_config/opencode`,
  ];
}

/**
 * デフォルトの tools ルート（`~/src/tools`）。`CHEZMOI_SOURCE_DIR` 環境変数で上書き可能。
 */
export function defaultToolsRoot(home: string): string {
  return `${home}/src/tools`;
}

/**
 * 判定結果からフック応答 JSON を組み立てる。
 * deny 時は Agent / ユーザー向けメッセージに canonical Source of Truth への誘導文言を含める。
 */
export function buildResponse(
  matchedPath: string | null,
  toolName: string,
  config: ResponseConfig,
): HookResponse {
  if (!matchedPath) {
    return { permission: "allow" };
  }
  return {
    permission: "deny",
    agent_message: `Direct edit to ${matchedPath} is blocked by the ${config.levelLabel} hook (tool: ${toolName}). Settings are deployed from \`${config.sourceRoot}\` to \`${config.destRoot}\` by ${config.syncDescription}. Edit the canonical Source of Truth under \`${config.sourceRoot}\`. For manual deploy, run ${config.manualSync}.`,
    user_message: `設定への直接編集がブロックされました: ${matchedPath}。\nこのディレクトリは \`tools/chezmoi/dot_cursor/\` から \`chezmoi apply\` 経由でデプロイされるため、直接編集すると次回 apply 時に上書きされます。\n代わりに \`tools/chezmoi/dot_cursor/agents/\` または \`tools/chezmoi/dot_cursor/skills/\` を編集してください。`,
  };
}

/**
 * 入力 JSON を受け取り、抽出 -> 正規化 -> 保護判定 -> 応答生成までを
 * まとめて行うオーケストレーション関数。main() から呼び出される。
 */
export function evaluateInput(
  input: unknown,
  env: {
    home: string;
    cwd: string;
    protectedRoots: readonly string[];
    responseConfig: ResponseConfig;
  },
): HookResponse {
  // 1. 入力 JSON から対象パスと tool 名を抽出する。
  const { toolName, path1, path2 } = extractPaths(input);

  // 2. 2 種類のパス（file_path / path および target_notebook）を絶対パスに正規化する。
  const abs1 = normalizePath(path1, env.home, env.cwd);
  const abs2 = normalizePath(path2, env.home, env.cwd);

  // 3. どちらかが保護ルート群のいずれかの配下にヒットしたらそのパスを記録する。
  let matched: string | null = null;
  if (isProtected(abs1, env.protectedRoots)) matched = abs1;
  else if (isProtected(abs2, env.protectedRoots)) matched = abs2;

  // 4. 判定結果から最終応答を組み立てて返す。
  return buildResponse(matched, toolName, env.responseConfig);
}

interface MainConfig {
  protectedRoots: string[];
  responseConfig: ResponseConfig;
}

function buildMainConfig(home: string, cwd: string): MainConfig {
  const scriptPath = __filename;

  // tools ルート決定: 環境変数 > デフォルト（`~/src/tools`）
  const toolsRoot = process.env.CHEZMOI_SOURCE_DIR
    ? process.env.CHEZMOI_SOURCE_DIR.replace(/\/chezmoi$/, "")
    : defaultToolsRoot(home);
  const protectedRoots = buildProtectedRoots(home, toolsRoot);

  // OpenCode user hook（`~/.config/opencode/plugins/agent-hooks/` で実行）
  if (scriptPath.includes("/.config/opencode/plugins/agent-hooks/")) {
    return {
      protectedRoots,
      responseConfig: OPENCODE_USER_RESPONSE,
    };
  }

  // Claude Code hooks
  const isClaudeHook = scriptPath.includes("/.claude/hooks/");
  if (!isClaudeHook) {
    return {
      protectedRoots,
      responseConfig: CURSOR_USER_RESPONSE,
    };
  }

  if (home && scriptPath.startsWith(`${home}/.claude/`)) {
    return {
      protectedRoots,
      responseConfig: CLAUDE_USER_RESPONSE,
    };
  }

  return {
    protectedRoots,
    responseConfig: CLAUDE_PROJECT_RESPONSE,
  };
}

/**
 * stdin から JSON 全体を一括読み込みする。読み取り失敗時は空文字列を返す。
 */
function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * エントリポイント本体。stdin -> 評価 -> stdout の JSON レスポンスを処理する。
 */
function main(): void {
  // 1. stdin を読み込む。
  const raw = readStdin();

  // 2. JSON パースを試行。失敗時は allow でフェイルセーフ。
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write('{"permission":"allow"}\n');
    return;
  }

  // 3. 環境情報を組み立てる（3 つの deployed ルート + 2 つの non-canonical source ルート）。
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  const config = buildMainConfig(home, cwd);
  const response = evaluateInput(parsed, {
    home,
    cwd,
    protectedRoots: config.protectedRoots,
    responseConfig: config.responseConfig,
  });

  // 4. 応答 JSON を stdout に書き出す。
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (require.main === module) {
  main();
}
