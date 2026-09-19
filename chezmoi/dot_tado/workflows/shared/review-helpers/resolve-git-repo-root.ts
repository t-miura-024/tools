import { execFileSync } from "node:child_process";
import { cleanGitEnv } from "./clean-git-env.ts";

/// `git rev-parse --show-toplevel` を Rust と同じクリーンな git 文脈
/// （GIT_DIR 等を除去）で実行し、リポジトリルートを返す。
export function resolveGitRepoRoot(): string | undefined {
  try {
    const repoRoot = String(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    ).trim();
    return repoRoot || undefined;
  } catch {
    return undefined;
  }
}
