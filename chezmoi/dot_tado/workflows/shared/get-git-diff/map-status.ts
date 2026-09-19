const STATUS_MAP: Record<string, string> = {
  A: "add",
  M: "modify",
  D: "delete",
  R: "rename",
  C: "copy",
};

export function mapStatus(code: string): string {
  return STATUS_MAP[code] ?? code;
}
