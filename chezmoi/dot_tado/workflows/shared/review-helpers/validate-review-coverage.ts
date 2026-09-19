import { isRecord } from "./is-record.ts";

/// ReviewCoverage の形状検証（純粋関数）。異常時は理由文、正常時は null。
export function validateReviewCoverage(value: unknown): string | null {
  if (!isRecord(value)) return "coverage is not an object";
  if (!Array.isArray(value.reviewers)) return "coverage.reviewers must be array";
  for (const reviewer of value.reviewers as unknown[]) {
    if (!isRecord(reviewer)) return "coverage.reviewers[] is not an object";
    if (
      typeof reviewer.index !== "number" ||
      !Number.isInteger(reviewer.index) ||
      reviewer.index < 1
    ) {
      return "coverage.reviewers[].index must be positive integer";
    }
    if (!Array.isArray(reviewer.perspectives)) {
      return "coverage.reviewers[].perspectives must be array";
    }
    for (const axis of reviewer.perspectives as unknown[]) {
      if (typeof axis !== "string" || !axis.trim()) {
        return "coverage.reviewers[].perspectives[] must be non-empty string";
      }
    }
  }
  if (!Array.isArray(value.diffFiles)) return "coverage.diffFiles must be array";
  for (const file of value.diffFiles as unknown[]) {
    if (typeof file !== "string" || !file.trim()) {
      return "coverage.diffFiles[] must be non-empty string";
    }
  }
  if (
    typeof value.diffAddedLines !== "number" ||
    !Number.isInteger(value.diffAddedLines) ||
    value.diffAddedLines < 0
  ) {
    return "coverage.diffAddedLines must be non-negative integer";
  }
  return null;
}
