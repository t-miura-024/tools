import type { GitResult } from "./types";

/// git 呼び出し1回あたりの上限。check経路と同様に同期実行が無制限に止まらないよう設ける。
export const GIT_TIMEOUT_MS = 30_000;

export function git(...args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  });
  // timeout時は exitCode が null になる（無制限ブロック防止）。空stderrのまま落とすと
  // 原因が消えるため、時間超過を明示する。
  if (result.exitCode === null || result.exitCode === undefined) {
    return {
      code: -1,
      stdout: result.stdout.toString(),
      stderr: `git ${args[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms`,
    };
  }
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
