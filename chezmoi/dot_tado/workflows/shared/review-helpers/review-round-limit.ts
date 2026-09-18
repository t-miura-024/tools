/// レビューラウンドの上限（ADR-0026）。round limit の判定規則は
/// `isRoundLimitReached` に一本化し、review-diff の collect_verdict と
/// plan-run の round_limit_gate が同じ写像を使う（写像ドリフト防止）。
export const REVIEW_ROUND_LIMIT = 5;
