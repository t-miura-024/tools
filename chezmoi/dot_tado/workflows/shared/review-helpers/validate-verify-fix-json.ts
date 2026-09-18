import type { VerifyFixJson } from "./types.ts";
import { isRecord } from "./is-record.ts";

/// verify-fix.json の機械検証（純粋関数）。
export function validateVerifyFixJson(raw: string | undefined): {
  valid: boolean;
  error?: string;
  parsed?: VerifyFixJson;
} {
  if (!raw) return { valid: false, error: "verify-fix.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "verify-fix.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { valid: false, error: "verify-fix.json is not an object" };
  if (parsed.status === "initial") {
    return { valid: true, parsed: { status: "initial" } };
  }
  if (parsed.status === "verified") {
    if (parsed.diffChanged !== true) {
      return { valid: false, error: "verified requires diffChanged: true" };
    }
    if (!Array.isArray(parsed.regressionTests) || parsed.regressionTests.length === 0) {
      return { valid: false, error: "verified requires non-empty regressionTests" };
    }
    for (const test of parsed.regressionTests as unknown[]) {
      if (typeof test !== "string" || !test.trim()) {
        return { valid: false, error: "regressionTests[] must be non-empty string" };
      }
    }
    return {
      valid: true,
      parsed: {
        status: "verified",
        diffChanged: true,
        regressionTests: parsed.regressionTests as string[],
      },
    };
  }
  if (parsed.status === "unfixed") {
    if (typeof parsed.reason !== "string" || !parsed.reason.trim()) {
      return { valid: false, error: "unfixed requires non-empty reason" };
    }
    return { valid: true, parsed: { status: "unfixed", reason: parsed.reason } };
  }
  return { valid: false, error: `invalid status: ${String(parsed.status)}` };
}
