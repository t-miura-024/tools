/** review-helpers 由来の純粋な型定義の集約（D・1関数1ファイルの例外として許容）。 */

// =============================================================================
// 検証観点プール — 15 観点 × 4 カテゴリ × 5 Tier を SoT とする
// =============================================================================

export type Width = "low" | "medium" | "high" | "xhigh" | "max";

export type Depth = "max" | "xhigh" | "high" | "medium" | "low";

export interface Perspective {
  id: string;
  label: string;
  name: string;
  category: string;
  tier: 1 | 2 | 3 | 4 | 5;
  summary: string;
}

// =============================================================================
// Findings / Verdict 型と検証
// =============================================================================

export type Severity = "must" | "should" | "want";

export interface Finding {
  axis: string;
  severity: Severity;
  detail: string;
  filePath?: string;
  position?: { side: "new" | "old"; line: number };
  suggestions?: string[];
}

export interface FilteredOutItem {
  axis: string;
  filePath?: string;
  line?: number;
  reason:
    | "file_not_in_diff"
    | "line_not_in_added"
    | "missing_position"
    | "old_side"
    | "missing_filePath";
  detail?: string;
}

export interface FindingsJson {
  round: number;
  width: Width;
  depth: Depth;
  findings: Finding[];
  counts: { must: number; should: number; want: number };
  filteredOut?: { count: number; items: FilteredOutItem[] };
  /// レビュー実施範囲の記録（ゼロ結果を「未検出」として透明化するための併記）。
  /// 判定には使わない（record-only）。欠落しても valid とする。
  coverage?: ReviewCoverage;
}

/// findings.json に併記するレビュー実施範囲。
/// - reviewers: 検証者番号と担当観点 ID（effort.json の width/depth からの機械導出）
/// - diffFiles: 検証対象差分に含まれるファイル一覧
/// - diffAddedLines: 検証対象の `+` 行総数
export interface ReviewCoverage {
  reviewers: Array<{ index: number; perspectives: string[] }>;
  diffFiles: string[];
  diffAddedLines: number;
}

/// 修正確認ステップ（verify_fix）の報告。
/// - initial: 初回（前ラウンドなし）のため検証対象なし
/// - verified: 差分変化と回帰テストの存在を確認済み
/// - unfixed: 修正なし（差分不変）または回帰テストなし。check が fail にする
export type VerifyFixJson =
  | { status: "initial" }
  | { status: "verified"; diffChanged: true; regressionTests: string[] }
  | { status: "unfixed"; reason: string };

export interface VerdictJson {
  round: number;
  width: Width;
  depth: Depth;
  passed: boolean;
  blocking_threads: Array<{
    id?: string;
    file?: string;
    line?: number | { start: number; end: number } | null;
    taxonomy?: string;
    body: string;
  }>;
  findingsPath?: string;
}

export type JsonRecord = Record<string, unknown>;

/// diff.txt のファイル別追加/削除行数（`git diff --numstat` との突合に使う）。
export interface DiffPathLineCounts {
  added: number;
  deleted: number;
}

/// diff.txt を行配列と行 Set へ 1 回だけ展開したインデックス（純粋データ）。
///
/// `diffCompletenessReasons` は truncate マーカー検査（行配列の走査）と untracked 突合
/// （行の完全一致）の両方でこのインデックスを共有する。呼び出しごとに
/// `diffRaw.split("\n")` と untracked 件数分の split を繰り返す O(F×L) を避ける。
export interface DiffTextIndex {
  lines: readonly string[];
  lineSet: ReadonlySet<string>;
}

/// `git diff --numstat -z` の 1 ファイル分。
/// 追加/削除行数が数値でない（バイナリ・サブモジュール等）場合は null。
export interface DiffNumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
  /// リネーム / コピーの元パス（numstat -z の 2 パス形式のときのみ）。
  origPath?: string;
}

// =============================================================================
// reviewer-outputs.json → findings.json の正規化監査 (純粋関数)
// =============================================================================

/// reviewer-outputs.json（生 findings）と findings.json（正規化後）の対応監査。
export interface FindingsNormalizationAudit {
  match: boolean;
  reasons: string[];
}

export interface DifitBlockingThread {
  id?: string;
  file?: string;
  line?: number | { start: number; end: number } | null;
  taxonomy?: string;
  body: string;
  replies?: string[];
}

/// difit のリビジョン選択（`CommentSelection` の JSON 表現）。
export interface DifitSelectionView {
  base: string;
  target: string;
  baseMode?: string;
}

/// 選択ドリフトの検知結果（Rust `DriftDetection` の三値）。
/// - `detected`: probe 成功かつサーバの現在選択 != 起動時選択
/// - `none`: probe 成功かつ一致（ドリフトなし）
/// - `unavailable`: probe 失敗（検知不能）。workflow は fail-closed で扱う
export type DifitDriftDetection = "detected" | "none" | "unavailable";

/// `mt difit check --dry-run` / `mt difit threads --json` の出力 JSON に載る
/// 選択ドリフト検知（Rust の `SelectionDrift` と同名の契約）。difit UI の
/// リビジョンセレクタが起動時（state.selection）と異なる場合に `detection` が
/// `"detected"` になる。probe 失敗時は `"unavailable"`（検知不能）で `current` は null。
export interface DifitSelectionDrift {
  detection: DifitDriftDetection;
  /// state に記録された起動時の選択（ゲートが読み書きするセッション）。
  expected?: DifitSelectionView;
  /// difit サーバが現在返す選択。probe 失敗時は undefined（Rust では null）。
  current?: DifitSelectionView;
}

export interface DifitCheckOutput {
  passes: boolean;
  blocking_threads: DifitBlockingThread[];
  /// Rust の `selection_drift`（`threads --json` / `check` 系は常に含み、done は省略する）。
  selection_drift?: DifitSelectionDrift;
  /// `selection_drift` フィールドは存在したが解釈できなかった場合の理由（契約違反）。
  /// 「ドリフトなし」へのフォールバックを避けるため、呼び出し元は
  /// `requireDifitSelectionDrift` で fail-closed に扱う。
  selection_drift_error?: string;
}

export interface DifitThreadReply {
  author: string | null;
  body: string;
}

/// `mt difit threads --json` の `threads[]` 1 件（未 resolve スレッドの読み取りビュー）。
export interface DifitThreadView {
  id: string;
  filePath: string;
  position: unknown;
  taxonomy: string;
  blocking: boolean;
  body: string;
  author: string | null;
  replies: DifitThreadReply[];
}

/// `mt difit threads --json` の出力契約。selected 固定・未 resolve スレッドと
/// `mt difit check` と同一分類の blocking_threads を返す。
export interface DifitThreadsOutput {
  passes: boolean;
  blocking_threads: DifitBlockingThread[];
  threads: DifitThreadView[];
  /// Rust の `selection_drift`（`mt difit threads --json` の出力契約）。
  /// 解釈できない場合は selection_drift_error が設定される（fail-closed で扱う）。
  selection_drift?: DifitSelectionDrift;
  selection_drift_error?: string;
}

/// `mt difit` サブコマンドの stdout / stderr。
export interface DifitCommandResult {
  stdout: string;
  stderr: string;
}

/// `difit-review.json` から読み取る生存判定用の最小状態。
export interface DifitReviewState {
  port: number;
  pid: number;
  /// state に記録された選択固定キー（`mt difit start` が probe した解決済み選択）。
  /// 旧 state（選択キー未記録）では undefined になり得る。
  selection?: DifitSelectionView;
}

/// `readDifitReviewState` の読み取り結果。
///
/// 「state 不在（ENOENT）」・「読み取り不能（EACCES / EISDIR / 競合）」・
/// 「契約違反（port / pid 不正）」を区別する。undefined に畳むと、done 後の
/// 後始末検証が読み取り失敗を『state 削除済み』と誤認して false pass し、
/// start の live 判定が一時的な読み取り障害を『セッション未起動』と誤診する。
export type DifitReviewStateRead =
  | { state: DifitReviewState }
  | { missing: true }
  | { error: string };

/// `cleanupDifitSession` の結果。
export interface DifitSessionCleanup {
  /// pass = `mt difit done` の後始末出力を取得し、state 消失と（控えられた場合は）
  /// 記録 pid の終了まで確認できた。error = 後始末完了を検証できない（fail-closed）。
  status: "pass" | "error";
  reasons: string[];
  /// `mt difit done` の stdout 契約出力（後始末出力が得られた場合のみ）。
  /// passes=false は「done 実行時点のゲート変化」であり後始末失敗ではない
  /// （人間が dry-run 突合後に未 resolve コメントを追加した場合等）。呼び出し元が判定する。
  done?: DifitCheckOutput;
  /// `mt difit done` の stderr を理由行へ整形したもの（空なら空配列）。
  stderr: string[];
}

/// `mt difit threads --json` の実行・パース結果。
export interface DifitThreadsFetchResult {
  /// stdout が契約（passes / blocking_threads / threads）を満たす場合のみ設定される。
  /// コマンド失敗・契約違反時は undefined（unpinned な `difit comment get` へは
  /// フォールバックしない。無音 pass を避ける）。
  output?: DifitThreadsOutput;
  /// コマンドの stderr（選択ドリフト警告・同一性照合エラー等）。成功・失敗を
  /// 問わず保持し、呼び出し元が CheckResult の理由へ流せるようにする。
  stderr: string;
}

/// effort.json（parse 済み）の機械検証（純粋関数）。
///
/// review-diff の resolve_effort check と plan-run の resolve_effort override が
/// 同じ写像（width / depth / base / target / round）を使う。plan-run の継続再入
/// （round_limit_gate の revise で execute_work の check が round を +1 した後）だけは
/// round > REVIEW_ROUND_LIMIT を人間が選んだ継続として許容するため、
/// `options.allowRoundOverflow` で round の超過のみを pass（overflow=true）へ畳む。
/// round 以外の契約（width / depth / base / target）は常に同じ判定を返す。
///
/// round は「1 以上の整数」で必須（欠落・0・小数・文字列は fail）。round の検証は
/// この関数が SoT であり、advanceReviewRound / advanceReviewRoundOnReentry /
/// collect_context check / normalize_findings の round 照合はすべてこの結果を使う
/// （サイトごとに合否が割れる手書き検証を置かない）。
export type EffortValidation =
  | { status: "pass"; width: Width; depth: Depth; round: number; overflow: boolean }
  | { status: "fail"; reasons: string[] }
  | { status: "error"; reasons: string[] };
