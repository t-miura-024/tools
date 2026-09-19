/// apply-feedback が統合した修正指示を保存するセッションファイル。
/// 内側ループ (autonomous-review-cycle) の先頭で組み立てられ、直後の execute-work が
/// 修正指示として読む。契約: `{ "items": [{ "source": "<findings|verdict|difit|gate:<stepKey>>", "body": "<原文>" }] }`。
/// 初回など修正ソースが無い実行では items: [] とする。source 語彙は
/// findings|verdict|difit|gate:<stepKey> のみ（check が allowlist 検証する）。
/// loop 外ゲート（identify-plan）の request_changes は巻き戻し不可のため
/// 統合対象外とし、gateAnswers に現れたら check が fail する。
export const FEEDBACK_KEY = "feedback.json";

export interface FeedbackItem {
  source: string;
  body: string;
}

/// feedback.json の items[].source 語彙。gate 差し戻しは `gate:<stepKey>` の一般形。
/// stepKey は kebab のため `-` を含む。
export const FEEDBACK_SOURCE_PATTERN = /^(findings|verdict|difit|gate:[A-Za-z0-9_-]+)$/;

/// apply-feedback が request_changes 差し戻しを統合する際の loop 外ゲート一覧。
/// loop 外で check が continue を返すとエンジンが fail-fast するため、loop 外ゲートに
/// request_changes を持たせない。gateAnswers に loop 外ゲートの request_changes が現れたら
/// （旧定義の残留・直 craft）、無音で捨てず apply-feedback の check が fail する。
export const LOOP_OUTSIDE_GATE_KEYS = ["identify-plan"] as const;

/// def 上の human_gate 定義の outcome 設問キー写像（ai-1）。
/// collect-gate-rework-requests はこのキーに解決できたゲートでは outcome 回答のみを
/// 差し戻し対象にし、補助設問の request_changes を幽霊差し戻しとして拾わない。
/// def 未登録のゲート（旧定義残留・直 craft）は outcome 不明のため undefined 相当
/// （写像に無いキー）として扱い、呼び出し元は従来どおり decision 優先の全キー走査で
/// 検出する（見落としの fail-closed）。
/// 新規 loop 内ゲート追加時はこの表への登録が必須。
export const OUTCOME_QUESTION_KEYS: Record<string, string> = {
  "identify-plan": "decision",
  "await-human-review": "decision",
};

/// ワークフロー定義の全ステップキー（loop 本体内を含む）。feedback.json の
/// `gate:<stepKey>` の実在確認に使う（`gate:fake-gate` 等の偽 source 混入を fail にする）。
/// 新規ステップ追加時はこの集合への追加が必須。
export const KNOWN_STEP_KEYS: ReadonlySet<string> = new Set([
  "identify-plan",
  "start-execution",
  "transcribe-docs",
  "human-review-cycle",
  "autonomous-review-cycle",
  "apply-feedback",
  "execute-work",
  "resolve-effort",
  "run-reviewers",
  "normalize-findings",
  "agent-verdict",
  "start-difit-review",
  "collect-verdict",
  "await-human-review",
  "judge-human",
  "finalize-done",
]);

/// verify-feedback-items への期待入力（apply-feedback と execute-work で共有）。
/// 両 check が別々に期待を組み立てると写像ドリフト（片方だけ被覆が緩い）を作るため、
/// 組み立ては build-feedback-coverage-expected に一本化する（logic-2）。
export interface FeedbackCoverageExpected {
  gateInputs: { gateKey: string; input: string }[];
  findingDetails: { index: number; severity: string; detail: string }[];
  verdictTexts: string[];
  difitTexts: string[];
  knownStepKeys: Set<string>;
  findingsAvailable: boolean;
  verdictAvailable: boolean;
  difitAvailable: boolean;
}
