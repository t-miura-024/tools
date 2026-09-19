import { describeDifitCommentKey } from "./describe-difit-comment-key.ts";
import { difitCommentKey } from "./difit-comment-key.ts";

/// `buildDifitComments(findings.json)` の期待出力と difit-comments.json を
/// 正規化比較する（純粋関数）。findings から 1 件でも落ちた部分集合・改変・余剰・
/// キー生成不能要素を検出し、欠落を可視化する。difit への注入前に normalize_findings が使う。
export function diffDifitComments(
  expected: unknown[],
  actual: unknown,
): { match: boolean; missing: string[]; unexpected: string[]; invalid: string[] } {
  // キー生成不能要素は invalid に記録する（読み飛ばさない）。invalid が空であることが
  // 「配列長とキー総数の一致」を意味し、position なしの余剰要素等を fail に落とす。
  const invalid: string[] = [];
  const countKeys = (values: unknown[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const result = difitCommentKey(value);
      if ("invalidReason" in result) {
        invalid.push(`[${index}] ${result.invalidReason}`);
        continue;
      }
      counts.set(result.key, (counts.get(result.key) ?? 0) + 1);
    }
    return counts;
  };

  const expectedCounts = countKeys(expected);
  const actualValues = Array.isArray(actual) ? actual : [];
  const actualCounts = countKeys(actualValues);

  const missing: string[] = [];
  for (const [key, count] of expectedCounts) {
    const actualCount = actualCounts.get(key) ?? 0;
    if (actualCount < count) missing.push(describeDifitCommentKey(key));
  }
  const unexpected: string[] = [];
  for (const [key, count] of actualCounts) {
    const expectedCount = expectedCounts.get(key) ?? 0;
    if (count > expectedCount) unexpected.push(describeDifitCommentKey(key));
  }

  return {
    match:
      Array.isArray(actual) &&
      invalid.length === 0 &&
      missing.length === 0 &&
      unexpected.length === 0,
    missing,
    unexpected,
    invalid,
  };
}
