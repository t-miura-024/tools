import type { Finding, Severity } from "./types.ts";

// =============================================================================
// 純粋関数: ±2 行マージ (機械ルール集約)
// =============================================================================

/// ±2 行以内の findings を 1 件へ統合する（純粋関数）。
/// 統合しても各 finding の型（filePath / position などの必須フィールド）は保持されるため、
/// ジェネリクスで呼び出し元の型をそのまま返す（buildDifitComments の position 必須化に使う）。
export function mergeFindingsByProximity<T extends Finding>(findings: T[]): T[] {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort((a, b) => {
    const fa = a.filePath ?? "";
    const fb = b.filePath ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    const la = a.position?.line ?? Number.POSITIVE_INFINITY;
    const lb = b.position?.line ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.axis.localeCompare(b.axis);
  });

  const severityRank: Record<Severity, number> = { must: 0, should: 1, want: 2 };

  const merged: T[] = [];
  let current: T | null = null;

  for (const f of sorted) {
    if (!current) {
      current = { ...f, suggestions: f.suggestions ? [...f.suggestions] : undefined };
      continue;
    }

    const sameFile =
      (current.filePath ?? "") === (f.filePath ?? "") && !!current.filePath && !!f.filePath;
    const curLine = current.position?.line;
    const nextLine = f.position?.line;
    const within2 =
      sameFile &&
      typeof curLine === "number" &&
      typeof nextLine === "number" &&
      Math.abs(nextLine - curLine) <= 2;

    if (within2) {
      const mergedDetail = `${current.detail.trim()}\n\n--- merged (±2) ---\n\n${f.detail.trim()}`;
      const mergedSeverity =
        severityRank[f.severity] < severityRank[current.severity] ? f.severity : current.severity;
      const mergedSuggestions = [...(current.suggestions ?? []), ...(f.suggestions ?? [])];
      current = {
        axis: current.axis,
        severity: mergedSeverity,
        detail: mergedDetail,
        filePath: current.filePath,
        position: current.position,
        ...(mergedSuggestions.length > 0 ? { suggestions: mergedSuggestions } : {}),
      } as T;
    } else {
      merged.push(current);
      current = { ...f, suggestions: f.suggestions ? [...f.suggestions] : undefined };
    }
  }
  if (current) merged.push(current);
  return merged;
}
