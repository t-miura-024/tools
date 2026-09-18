import type { DifitCheckOutput } from "./types.ts";
import { findJsonObject } from "./find-json-object.ts";
import { parseDifitCheckRecord } from "./parse-difit-check-record.ts";

/// `mt difit check` / `mt difit done` の stdout JSON をパースする。
export function parseDifitCheck(raw: string | undefined): DifitCheckOutput | undefined {
  return parseDifitCheckRecord(findJsonObject(raw));
}
