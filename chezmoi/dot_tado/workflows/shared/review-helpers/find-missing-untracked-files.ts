import type { DiffTextIndex } from "./types.ts";
import { diffContainsUntrackedFile } from "./diff-contains-untracked-file.ts";

/// untracked 一覧と diff.txt の出現を突合し、差分が見つからないファイルを返す（純粋関数）。
export function findMissingUntrackedFiles(
  index: DiffTextIndex,
  untrackedFiles: readonly string[],
): string[] {
  return untrackedFiles.filter((filePath) => !diffContainsUntrackedFile(index, filePath));
}
