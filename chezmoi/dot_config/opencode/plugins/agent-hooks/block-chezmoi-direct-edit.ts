#!/usr/bin/env bun
/**
 * ユーザーレベルの preToolUse hook。
 * chezmoi 管理下のホーム dotfile への直接編集をブロックし、canonical Source of Truth（chezmoi source）への編集を誘導する。
 *
 * 動作保証: OpenCode のみ。
 *   - OpenCode は `cursor-hook-bridge.ts` 経由で実機動作を検証済み。
 *   - Cursor / Claude Code の hooks（`~/.cursor/hooks.json` / `~/.claude/settings.json`）からも
 *     参照されるが、実機でのフック発火は未検証のため保証対象外。
 *
 * ブロック対象:
 *   ホーム配下に存在する、`chezmoi source-path <path>` で管理下と判定される既存ファイル
 *   （`.zshrc`, `.gitconfig`, `.config/nvim/**`, `.config/opencode/**` 等、chezmoi 管理の全 dotfile）
 *
 * 誘導先（canonical）:
 *   作業中ワークツリー（cwd の git toplevel 直下）に chezmoi source がある場合はその `chezmoi/`、
 *   それ以外は `chezmoi source-path` で解決されるソースディレクトリ（デフォルト `~/src/tools/chezmoi`）。
 *
 * 配置場所:
 *   `chezmoi/dot_config/opencode/plugins/agent-hooks/block-chezmoi-direct-edit.ts` から
 *   `chezmoi apply` 経由で `~/.config/opencode/plugins/agent-hooks/` にデプロイされ、
 *   3 つの platform 設定ファイル（`~/.cursor/hooks.json` /
 *   `~/.claude/settings.json` / `cursor-hook-bridge.ts`）から共通参照される。
 *
 * 自己完結性:
 *   単一ファイルで配布されるため、外部モジュールの import を禁止する（テスト以外）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

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
 * 絶対パスがホームディレクトリ配下（またはホーム自身）かを判定する。
 * chezmoi source（`~/src/tools/chezmoi`）もホーム配下にあるため、
 * ブロック判定はこの後 `chezmoi source-path` の管理判定で絞る。
 */
export function isUnderHome(absPath: string, home: string): boolean {
  return absPath === home || absPath.startsWith(`${home}/`);
}

/**
 * ディレクトリが chezmoi source として機能するか判定する。
 * `.chezmoiignore` か `dot_config` の存在で判定する。
 */
export function isChezmoiSourceDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, ".chezmoiignore")) ||
    fs.existsSync(path.join(dir, "dot_config"))
  );
}

/**
 * cwd が属する git リポジトリの toplevel（worktree root）を返す。
 * git リポジトリ外なら null。
 */
export function gitToplevel(cwd: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const out = res.stdout?.trim();
  return out || null;
}

/**
 * chezmoi のソースディレクトリを返す（`chezmoi source-path` の引数なし）。
 * 取得失敗時は null。
 */
export function chezmoiSourceDir(): string | null {
  const res = spawnSync("chezmoi", ["source-path"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const out = res.stdout?.trim();
  return out || null;
}

/**
 * 対象ホームパスが chezmoi 管理下かを判定し、管理下ならソースパスを返す。
 * 非管理・取得失敗時は null。
 */
export function chezmoiSourcePath(targetAbs: string): string | null {
  const res = spawnSync("chezmoi", ["source-path", targetAbs], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const out = res.stdout?.trim();
  return out || null;
}

/**
 * 誘導先の canonical root を解決する。
 * - cwd の git toplevel 直下に chezmoi source があれば、その `chezmoi/`（作業中ワークツリー優先）
 * - それ以外は `chezmoi source-path` で解決されるソースディレクトリ
 * - いずれも失敗時は `~/src/tools/chezmoi` にフォールバック
 */
export function resolveGuideRoot(home: string, cwd: string): string {
  const toplevel = gitToplevel(cwd);
  if (toplevel) {
    const candidate = path.join(toplevel, "chezmoi");
    if (isChezmoiSourceDir(candidate)) return candidate;
  }
  return chezmoiSourceDir() || path.join(home, "src", "tools", "chezmoi");
}

/**
 * 解決したソースパスを、誘導先 root 配下のパスへ置き換える。
 * sourceDir が不明またはプレフィックス不一致の場合はソースパスをそのまま返す。
 */
export function buildGuidePath(
  sourcePath: string,
  sourceDir: string | null,
  guideRoot: string,
): string {
  if (sourceDir && sourcePath.startsWith(`${sourceDir}/`)) {
    const rel = sourcePath.slice(sourceDir.length + 1);
    return path.join(guideRoot, rel);
  }
  return sourcePath;
}

export interface EvalResult {
  matched?: string;
  guidePath?: string;
  toolName?: string;
}

/**
 * 入力 JSON を受け取り、抽出 -> 正規化 -> chezmoi 管理判定 -> 誘導先解決までを
 * まとめて行う。ホーム配下の chezmoi 管理ファイルの編集は deny 対象として返す。
 */
export function evaluateInput(
  input: unknown,
  env: { home: string; cwd: string },
): EvalResult {
  const { toolName, path1, path2 } = extractPaths(input);
  const sourceDir = chezmoiSourceDir();
  const guideRoot = resolveGuideRoot(env.home, env.cwd);

  for (const p of [path1, path2]) {
    const abs = normalizePath(p, env.home, env.cwd);
    if (!abs || !isUnderHome(abs, env.home)) continue;
    const sourcePath = chezmoiSourcePath(abs);
    if (!sourcePath) continue;
    return {
      matched: abs,
      guidePath: buildGuidePath(sourcePath, sourceDir, guideRoot),
      toolName,
    };
  }
  return { toolName };
}

export interface HookResponse {
  permission: "allow" | "deny";
  agent_message?: string;
  user_message?: string;
}

/**
 * 判定結果からフック応答 JSON を組み立てる。
 * deny 時は Agent / ユーザー向けメッセージに canonical Source of Truth への誘導文言を含める。
 */
export function buildResponse(result: EvalResult): HookResponse {
  if (!result.matched) {
    return { permission: "allow" };
  }
  const guidePath = result.guidePath ?? result.matched;
  const tool = result.toolName ?? "unknown";
  return {
    permission: "deny",
    agent_message: `Direct edit to ${result.matched} is blocked by the user-level chezmoi hook (tool: ${tool}). This file is managed by chezmoi. Edit the canonical source at \`${guidePath}\` instead, then deploy with \`mt chezmoi apply\`.`,
    user_message: `chezmoi 管理下のファイルへの直接編集はブロックされました: ${result.matched}。\nこのファイルは \`chezmoi apply\` でデプロイされるため、直接編集すると次回 apply 時に上書きされます。\n代わりに \`${guidePath}\` を編集し、\`mt chezmoi apply\` で反映してください。`,
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

  // 3. 環境情報を組み立てる。
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  const result = evaluateInput(parsed, { home, cwd });
  const response = buildResponse(result);

  // 4. 応答 JSON を stdout に書き出す。
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (require.main === module) {
  main();
}
