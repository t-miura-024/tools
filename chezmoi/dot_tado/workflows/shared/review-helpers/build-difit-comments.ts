import type { Finding, JsonRecord, Severity } from "./types.ts";
import { findJsonObject } from "./find-json-object.ts";
import { formatReviewComment } from "./format-review-comment.ts";
import { isRecord } from "./is-record.ts";
import { mergeFindingsByProximity } from "./merge-findings-by-proximity.ts";
import { optionalLocation } from "./optional-location.ts";
import { positionToNewLine } from "./position-to-new-line.ts";
import { VALID_AXIS_IDS } from "./valid-axis-ids.ts";

/// findings.json を difit comment import 形式の JSON 配列へ変換する (純粋関数)。
///
/// 各要素は `{"type":"thread","filePath":...,"position":{"side":"new","line":...},"body":...}`。
/// body は formatReviewComment が生成する GFM Markdown（severity / taxonomy / axis を絵文字で継承）。
/// filePath なし / position なし / `side:"old"` / line 不正は機械的に除外する（diff-only 規律）。
export function buildDifitComments(findingsRaw: string | undefined): JsonRecord[] {
  // map で filePath / position を検証済みの型。mergeFindingsByProximity は filePath /
  // position を保持するため、統合後もこの型のまま扱える（再検証は到達不能なデッドコード）。
  type PositionedFinding = Finding & {
    filePath: string;
    position: { side: "new"; line: number };
  };
  const comments: JsonRecord[] = [];
  const parsed = findJsonObject(findingsRaw);
  const findingsArray: unknown[] = Array.isArray(parsed?.findings)
    ? (parsed!.findings as unknown[])
    : [];

  const normalized = findingsArray
    .filter(isRecord)
    .map((item): PositionedFinding | null => {
      const r = item as JsonRecord;
      const severity = r.severity;
      const detail = r.detail;
      const axis = r.axis;
      if (typeof axis !== "string" || !VALID_AXIS_IDS.has(axis)) return null;
      if (severity !== "must" && severity !== "should" && severity !== "want") return null;
      if (typeof detail !== "string" || !detail.trim()) return null;
      const location = optionalLocation(r);
      if (typeof location.filePath !== "string" || !location.filePath.trim()) return null;
      const line = positionToNewLine(location.position);
      if (line === undefined) return null;
      const rawSuggestions = (r.suggestions ??
        r.suggestion ??
        r.proposals ??
        r.proposal) as unknown;
      let suggestions: string[] | undefined;
      if (Array.isArray(rawSuggestions)) {
        const filtered = (rawSuggestions as unknown[]).filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        if (filtered.length > 0) suggestions = filtered.map((s) => s.trim());
      } else if (typeof rawSuggestions === "string" && rawSuggestions.trim()) {
        suggestions = [rawSuggestions.trim()];
      }
      return {
        axis,
        severity: severity as Severity,
        detail: detail.trim(),
        filePath: location.filePath.trim(),
        position: { side: "new", line },
        ...(suggestions ? { suggestions } : {}),
      };
    })
    .filter((finding): finding is PositionedFinding => finding !== null);

  const merged = mergeFindingsByProximity(normalized);

  for (const f of merged) {
    const { body } = formatReviewComment({
      severity: f.severity,
      axis: f.axis,
      detail: f.detail,
      filePath: f.filePath,
      line: f.position.line,
      suggestions: f.suggestions,
    });
    comments.push({
      type: "thread",
      filePath: f.filePath,
      position: { side: "new", line: f.position.line },
      body,
    });
  }

  return comments;
}
