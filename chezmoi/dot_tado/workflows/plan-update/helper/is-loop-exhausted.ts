import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isGateAnswerRecord } from "../types.ts";

/// loop 枯渇マーカーの検出。自 loop のマーカーでのみ true（相互隔離）。
export function isLoopExhausted(sessionDir: string, markerKey: string, loopKey: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, markerKey), "utf-8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isGateAnswerRecord(parsed) && (parsed as { loop?: unknown }).loop === loopKey;
  } catch {
    return false;
  }
}
