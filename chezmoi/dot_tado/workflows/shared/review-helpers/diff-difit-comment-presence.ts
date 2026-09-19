import type { DifitThreadView } from "./types.ts";
import { describeDifitCommentKey } from "./describe-difit-comment-key.ts";
import { difitCommentKey } from "./difit-comment-key.ts";

/// `difit-comments.json`（注入側）の各コメントが `mt difit threads --json` の
/// `threads[]`（選択固定・read-only のサーバ実体）に `{filePath, position.side,
/// position.line, body}` の組の multiset として存在することを検証する（純粋関数）。
///
/// start_difit_review の再入では、サーバに前ラウンドの未 resolve スレッドや人間
/// コメントが残るため、サーバ側の余剰は許容する（containment 検証）。注入側の
/// 欠落（同一 body の片方欠落を含む）・位置 / side の差し替え・キー生成不能を
/// missing / invalid として検出する。サーバ側でキー生成できない要素（人間の範囲
/// コメント等）は照合対象外とする（一致すべき注入コメントは常に valid な位置を持つ）。
export function diffDifitCommentPresence(
  expected: unknown[],
  actualThreads: readonly DifitThreadView[],
): { match: boolean; missing: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const expectedCounts = new Map<string, number>();
  for (const [index, value] of expected.entries()) {
    const result = difitCommentKey(value);
    if ("invalidReason" in result) {
      invalid.push(`[${index}] ${result.invalidReason}`);
      continue;
    }
    expectedCounts.set(result.key, (expectedCounts.get(result.key) ?? 0) + 1);
  }

  const actualCounts = new Map<string, number>();
  for (const thread of actualThreads) {
    const result = difitCommentKey({
      type: "thread",
      filePath: thread.filePath,
      position: thread.position,
      body: thread.body,
    });
    if ("invalidReason" in result) continue;
    actualCounts.set(result.key, (actualCounts.get(result.key) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const [key, count] of expectedCounts) {
    if ((actualCounts.get(key) ?? 0) < count) missing.push(describeDifitCommentKey(key));
  }

  return {
    match: invalid.length === 0 && missing.length === 0,
    missing,
    invalid,
  };
}
