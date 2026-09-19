import type { DiffTextIndex } from "./types.ts";
import { diffContainsPath } from "./diff-contains-path.ts";

/// diff.txt が untracked ファイル `filePath` の差分を含むか（純粋関数）。
/// 見出し候補の生成は diffContainsPath に集約する。
export function diffContainsUntrackedFile(index: DiffTextIndex, filePath: string): boolean {
  return diffContainsPath(index, filePath);
}
