import { execFileSync } from "node:child_process";
import { cleanGitEnv } from "./clean-git-env.ts";
import { hashPrefix } from "./hash-prefix.ts";

/// `git merge-base <a> <b>` の full hash から difit 短縮表示を作る。
export function resolveGitMergeBasePrefix(a: string, b: string): string | undefined {
  try {
    const out = String(
      execFileSync("git", ["merge-base", a, b], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    );
    return hashPrefix(out);
  } catch {
    return undefined;
  }
}
