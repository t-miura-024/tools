import type { DifitBlockingThread, DifitCheckOutput, JsonRecord } from "./types.ts";
import { inspectDifitSelectionDrift } from "./inspect-difit-selection-drift.ts";
import { isRecord } from "./is-record.ts";

/// パース済みオブジェクトから `mt difit check` / `mt difit done` の契約
/// （passes / blocking_threads / selection_drift）を取り出す。
/// `fetchDifitThreads` が 1 回の JSON.parse 結果を再利用するために分離している。
export function parseDifitCheckRecord(
  parsed: JsonRecord | undefined,
): DifitCheckOutput | undefined {
  if (!parsed || typeof parsed.passes !== "boolean" || !Array.isArray(parsed.blocking_threads)) {
    return undefined;
  }
  const blockingThreads: DifitBlockingThread[] = [];
  for (const value of parsed.blocking_threads) {
    if (!isRecord(value) || typeof value.body !== "string") return undefined;
    const replies = Array.isArray(value.replies)
      ? value.replies.filter((reply): reply is string => typeof reply === "string")
      : [];
    blockingThreads.push({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.file === "string" ? { file: value.file } : {}),
      ...(typeof value.line === "number" || isRecord(value.line)
        ? { line: value.line as DifitBlockingThread["line"] }
        : {}),
      ...(typeof value.taxonomy === "string" ? { taxonomy: value.taxonomy } : {}),
      body: value.body,
      replies,
    });
  }
  const inspectedDrift = inspectDifitSelectionDrift(parsed.selection_drift);
  return {
    passes: parsed.passes,
    blocking_threads: blockingThreads,
    ...(inspectedDrift && "drift" in inspectedDrift
      ? { selection_drift: inspectedDrift.drift }
      : {}),
    // フィールド欠落（done 経路で正当）と解釈不能（契約違反）を区別して保持する。
    ...(inspectedDrift && "error" in inspectedDrift
      ? { selection_drift_error: inspectedDrift.error }
      : {}),
  };
}
