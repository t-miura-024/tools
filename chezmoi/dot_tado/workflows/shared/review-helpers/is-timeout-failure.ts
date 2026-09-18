export function isTimeoutFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ETIMEDOUT") return true;
  return error instanceof Error && /ETIMEDOUT|timed?\s*out/i.test(error.message);
}
