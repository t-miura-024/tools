import type { DiffTextIndex } from "./types.ts";

/// diff テキストを 1 回だけ split して DiffTextIndex を作る。
export function indexDiffText(diffRaw: string): DiffTextIndex {
  const lines = diffRaw.split("\n");
  return { lines, lineSet: new Set(lines) };
}
