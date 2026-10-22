import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_ROUND_KEY } from "./review-limits.ts";

/// 最後に完了したレビューラウンド番号。未作成は 0。
export function readReviewRound(sessionDir: string): number {
  try {
    const raw = readFileSync(join(sessionDir, REVIEW_ROUND_KEY), "utf-8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export function writeReviewRound(sessionDir: string, round: number): void {
  writeFileSync(join(sessionDir, REVIEW_ROUND_KEY), `${round}\n`, "utf-8");
}
