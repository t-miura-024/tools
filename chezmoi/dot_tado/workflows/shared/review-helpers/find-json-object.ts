import type { JsonRecord } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { parseJson } from "./parse-json.ts";

export function findJsonObject(raw: string | undefined): JsonRecord | undefined {
  const parsed = parseJson(raw);
  if (isRecord(parsed)) return parsed;
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  if (start === 0 && end === raw.length - 1) return undefined;
  return findJsonObject(raw.slice(start, end + 1));
}
