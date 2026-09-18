import type { FindingsJson } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { VALID_AXIS_IDS } from "./valid-axis-ids.ts";
import { VALID_DEPTHS } from "./valid-depths.ts";
import { VALID_SEVERITIES } from "./valid-severities.ts";
import { VALID_WIDTHS } from "./valid-widths.ts";
import { validateReviewCoverage } from "./validate-review-coverage.ts";

// findings.json の機械検証 (純粋関数)
export function validateFindingsJson(raw: string | undefined): {
  valid: boolean;
  error?: string;
  parsed?: FindingsJson;
} {
  if (!raw) return { valid: false, error: "findings.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "findings.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { valid: false, error: "findings.json is not an object" };
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
  if (!Array.isArray(r.findings)) return { valid: false, error: "missing findings array" };
  if (!isRecord(r.counts)) return { valid: false, error: "missing counts" };
  const counts = r.counts as Record<string, unknown>;
  if (
    typeof counts.must !== "number" ||
    typeof counts.should !== "number" ||
    typeof counts.want !== "number"
  ) {
    return { valid: false, error: "counts must have must/should/want numbers" };
  }

  let must = 0;
  let should = 0;
  let want = 0;
  for (const item of r.findings as unknown[]) {
    if (!isRecord(item)) return { valid: false, error: "finding is not an object" };
    if (typeof item.axis !== "string" || !VALID_AXIS_IDS.has(item.axis)) {
      return { valid: false, error: `invalid axis: ${String(item.axis)}` };
    }
    if (typeof item.severity !== "string" || !VALID_SEVERITIES.has(item.severity)) {
      return { valid: false, error: `invalid severity: ${String(item.severity)}` };
    }
    if (typeof item.detail !== "string" || !item.detail.trim()) {
      return { valid: false, error: "finding detail is missing or empty" };
    }
    if (typeof item.filePath !== "string" || !item.filePath.trim()) {
      return { valid: false, error: "filePath is required and must be non-empty string" };
    }
    if (!isRecord(item.position)) {
      return { valid: false, error: "position is required and must be object" };
    }
    if (item.position.side !== "new") {
      return { valid: false, error: 'position.side must be "new"' };
    }
    if (
      typeof item.position.line !== "number" ||
      !Number.isInteger(item.position.line) ||
      item.position.line < 1
    ) {
      return { valid: false, error: "position.line must be positive integer" };
    }
    if (item.suggestions !== undefined) {
      if (!Array.isArray(item.suggestions))
        return { valid: false, error: "suggestions must be array" };
      for (const s of item.suggestions as unknown[]) {
        if (typeof s !== "string") return { valid: false, error: "suggestion must be string" };
      }
    }
    if (item.severity === "must") must++;
    else if (item.severity === "should") should++;
    else if (item.severity === "want") want++;
  }

  if (must !== counts.must || should !== counts.should || want !== counts.want) {
    return {
      valid: false,
      error: `counts mismatch: expected must=${must} should=${should} want=${want}, got must=${counts.must} should=${counts.should} want=${counts.want}`,
    };
  }

  // coverage は record-only（判定に使わない）。存在する場合のみ形状を検証する。
  if (r.coverage !== undefined) {
    const coverageError = validateReviewCoverage(r.coverage);
    if (coverageError) return { valid: false, error: coverageError };
  }

  return { valid: true, parsed: parsed as unknown as FindingsJson };
}
