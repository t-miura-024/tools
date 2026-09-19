import type { ReviewCoverage } from "./types.ts";

/// 検証者割り当てと差分 `+` 行 Map から ReviewCoverage を組み立てる（純粋関数）。
/// normalize_findings が findings.json へ併記する期待内容の正典。
export function buildReviewCoverage(
  assignments: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  changedLinesMap: ReadonlyMap<string, ReadonlySet<number>>,
): ReviewCoverage {
  let diffAddedLines = 0;
  const diffFiles: string[] = [];
  for (const [filePath, lines] of changedLinesMap) {
    diffFiles.push(filePath);
    diffAddedLines += lines.size;
  }
  diffFiles.sort();
  return {
    reviewers: assignments.map((perspectives, index) => ({
      index: index + 1,
      perspectives: perspectives.map((p) => p.id),
    })),
    diffFiles,
    diffAddedLines,
  };
}
