import { execFileSync } from "node:child_process";
import { cleanGitEnv } from "./clean-git-env.ts";
import { GIT_LIST_MAX_BUFFER_BYTES } from "./git-list-max-buffer-bytes.ts";

/// git をクリーンな文脈（GIT_DIR 等を除去）で実行し stdout を返す。
/// 失敗は例外のまま伝播し、呼び出し元が error 理由へ変換する。
/// cwd は実行ディレクトリ（既定は process.cwd()）。
export function execGit(
  args: string[],
  options: { cwd?: string; maxBuffer?: number } = {},
): string {
  return String(
    execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: options.maxBuffer ?? GIT_LIST_MAX_BUFFER_BYTES,
      env: cleanGitEnv(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }),
  );
}
