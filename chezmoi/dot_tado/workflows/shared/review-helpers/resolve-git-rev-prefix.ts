import { execFileSync } from "node:child_process";
import { cleanGitEnv } from "./clean-git-env.ts";
import { hashPrefix } from "./hash-prefix.ts";

/// `git rev-parse <ref>` の full hash から difit 短縮表示を作る。
export function resolveGitRevPrefix(ref: string): string | undefined {
  try {
    const out = String(
      execFileSync("git", ["rev-parse", ref], {
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
