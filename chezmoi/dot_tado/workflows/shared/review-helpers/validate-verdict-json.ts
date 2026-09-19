import type { VerdictJson } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { VALID_DEPTHS } from "./valid-depths.ts";
import { VALID_WIDTHS } from "./valid-widths.ts";

export function validateVerdictJson(raw: string | undefined): {
  valid: boolean;
  error?: string;
  parsed?: VerdictJson;
} {
  if (!raw) return { valid: false, error: "verdict.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "verdict.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { valid: false, error: "verdict.json is not an object" };
  const r = parsed as Record<string, unknown>;
  if (typeof r.round !== "number" || !Number.isInteger(r.round) || r.round < 1) {
    return { valid: false, error: "missing or invalid round" };
  }
  if (typeof r.width !== "string" || !VALID_WIDTHS.has(r.width)) {
    return { valid: false, error: `invalid width: ${String(r.width)}` };
  }
  if (typeof r.depth !== "string" || !VALID_DEPTHS.has(r.depth)) {
    return { valid: false, error: `invalid depth: ${String(r.depth)}` };
  }
  if (typeof r.passed !== "boolean") return { valid: false, error: "missing or invalid passed" };
  if (!Array.isArray(r.blocking_threads))
    return { valid: false, error: "missing blocking_threads" };
  for (const t of r.blocking_threads as unknown[]) {
    if (!isRecord(t) || typeof t.body !== "string")
      return { valid: false, error: "blocking_threads body invalid" };
  }
  return { valid: true, parsed: parsed as unknown as VerdictJson };
}
