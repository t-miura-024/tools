import { isRecord } from "./is-record.ts";

export function positionToNewLine(position: unknown): number | undefined {
  if (!isRecord(position)) return undefined;
  const line = position.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  if (position.side !== "new") return undefined;
  return line;
}
