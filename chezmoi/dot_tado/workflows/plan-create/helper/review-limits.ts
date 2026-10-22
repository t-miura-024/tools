/// plan-create のレビューサイクルで共有する定数。
/// 内側（自動 review→grill）と外側（人間差し戻し）の反復上限を一箇所に固定する。
export const REVIEW_FIX_MAX_ITERATIONS = 3;
export const REVIEW_CYCLE_MAX_ITERATIONS = 3;

export const REVIEW_FINDINGS_KEY = "review-findings.json";
export const REVIEW_BODY_KEY = "review-body.md";
export const REVIEW_DECISIONS_KEY = "review-decisions.md";
export const REVIEW_ROUND_KEY = "review-round.txt";
export const FROM_ISSUE_KEY = "from-issue.md";
export const REVIEW_CYCLE_EXHAUSTED_MARKER = "review-cycle-exhausted.json";
