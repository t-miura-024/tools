export function isMaxBufferOverflow(error: unknown): boolean {
  // Node は ERR_CHILD_PROCESS_STDIO_MAXBUFFER、bun は ENOBUFS を返す。
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || code === "ENOBUFS") return true;
  return error instanceof Error && /maxBuffer/i.test(error.message);
}
