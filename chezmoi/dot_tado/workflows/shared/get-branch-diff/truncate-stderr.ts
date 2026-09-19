/// fail理由に埋めるstderrの上限行数。巨大なgit警告でJSONが膨張しないよう先頭のみ残す。
export const STDERR_MAX_LINES = 10;

export function truncateStderr(stderr: string, maxLines: number = STDERR_MAX_LINES): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  if (lines.length <= maxLines) return trimmed;
  return lines.slice(0, maxLines).join("\n");
}
