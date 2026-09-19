import { execFileSync } from "node:child_process";
import { cleanGitEnv } from "./clean-git-env.ts";

/// effort.json の base 未指定時に collect_context / `mt difit start` が使う既定 base を
/// 解決する（`origin/HEAD` のブランチ名 → 失敗時 `main`）。
/// base が明示されていれば trim してそのまま返す（git 実行なし）。
export function resolveEffectiveEffortBase(base?: unknown): string {
  if (typeof base === "string" && base.trim()) return base.trim();
  try {
    const out = String(
      execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    ).trim();
    const name = out.replace(/^origin\//, "");
    if (name) return name;
  } catch {
    // origin/HEAD が無い・git 実行失敗時は main（collect_context と同じ既定）
  }
  return "main";
}
