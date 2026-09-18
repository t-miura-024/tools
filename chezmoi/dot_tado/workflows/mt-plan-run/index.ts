import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ConditionCtx,
  ArtifactRecord,
  GateAnswers,
} from "tado";
import { join } from "node:path";
import fs from "node:fs";
import type { StepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../_shared/mt-prompt";
import type { PromptItem } from "../_shared/mt-prompt";
import { loadConfig } from "../_shared/mt-plan-init-config";
// NOTE(ADR-0019): Step import は StepDef のみに限定する方針を grill で合意済み。
// mt-review-diff が敵対的検証の単一 SoT であり、mt-plan-run は StepDef 定義のみを
// 直接 import して再利用する。純粋関数・定数 (findArtifactText 等) は
// _shared/mt-review-helpers.ts が SoT であり、Step 以外は _shared 経由で import する。
// NOTE(arch-2): buildStepPrompt は _shared/mt-prompt.ts 経由に集約済み（純粋フォーマッターであり ADR-0019 の StepDef 限定と競合しない）。
// resolve_effort の human_gate は廃止済みのため、effort 解決は Issue body コメント
// （mt-plan-create が書く `<!-- effort: ... -->`）または medium/medium のみで行う。
import {
  resolveEffortStep,
  runReviewersStep,
  normalizeFindingsStep,
  startDifitReviewStep,
  awaitHumanReviewStep,
  collectAutonomousVerdictStep,
  completeHumanReviewStep,
} from "../mt-review-diff/index.ts";
import {
  findArtifactText,
  readSessionFile,
  validateFindingsJson,
  validateVerdictJson,
  parseDifitCheck,
  isRecord,
  isolateDifitFeedback,
  describeDifitSelectionDrift,
  requireDifitSelectionDrift,
  DIFIT_CHECK_KEY,
  FINDINGS_KEY as REVIEW_FINDINGS_KEY,
  VERDICT_KEY as REVIEW_VERDICT_KEY,
  EFFORT_KEY as REVIEW_EFFORT_KEY,
  REVIEW_ROUND_LIMIT,
  VALID_WIDTHS,
  VALID_DEPTHS,
} from "../_shared/mt-review-helpers.ts";
import type { FindingsJson, VerdictJson } from "../_shared/mt-review-helpers.ts";
import { requireStepArtifacts } from "../_shared/artifact-check";
import { verifyIssueClosed } from "../_shared/gh-issue-verify";
import {
  collectPlanReviewContext,
  effortFromIssueBody,
} from "../_shared/collect-plan-review-context.ts";

/**
 * executor 向けの difit フィードバック文面。
 *
 * taxonomy / blocking の権威は Rust の `src/difit/gate.rs`
 * （`mt difit check` / `mt difit threads --json` / difit-check.json の blocking_threads）。
 * この文面は機械出力の値をそのまま表示しつつ、want 昇格（人間 reply が付いた want のみ
 * blocking_threads に現れる）の説明を再記述する。mt-review-diff/index.ts の
 * NOTE(arch-1) が列挙する分類規則の同期対象であり、規則変更時は同時更新が必要
 * （execute_work プロンプトの resolve 運用も同様）。
 */
function formatDifitFeedback(ctx: PromptCtx): string | undefined {
  const raw =
    findArtifactText(ctx.artifacts, DIFIT_CHECK_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, DIFIT_CHECK_KEY);
  const result = parseDifitCheck(raw);
  if (!result) return undefined;
  const drift = result.selection_drift;
  // `detected`（ドリフト中）と `unavailable`（probe 失敗＝検知不能）はどちらも
  // resolve の行き先を確認できない状態であり、executor へフィードバックする。
  const driftFailure = drift && drift.detection !== "none" ? drift : undefined;
  // 契約違反マーカー（selection_drift_error）は requireDifitSelectionDrift の違反として
  // driftFailure と同じ経路に載せる。これがないと passes=true のときに無音で
  // 空フィードバックになり、検知不能が「修正対象なし」と誤認される。
  // フィールド欠落は `mt difit done` 出力（drift を省略する正当な経路）でも起こるため、
  // ここでは契約違反と断定しない（欠落を違反に倒すのは check / threads の消費者）。
  const driftContract = requireDifitSelectionDrift(result);
  const driftViolation =
    "violation" in driftContract && result.selection_drift_error
      ? driftContract.violation
      : undefined;
  // passes=true ⇒ blocking_threads 空が `mt difit check` の契約。passes=true かつ
  // blocking 非空という契約違反出力では blocking 一覧を無音で捨てず、違反として理由に
  // 積んで提示する。早期 return は「blocking 空 && drift なし && 契約違反なし」の
  // 1 条件に統合する（旧 2 段 early return は不整合分岐を無音化していた）。
  const contractViolations: string[] = [];
  if (result.passes && result.blocking_threads.length > 0) {
    contractViolations.push(
      `契約違反: passes=true なのに blocking_threads が ${result.blocking_threads.length} 件あります。mt difit check の契約では passes=true ⇒ blocking_threads 空です。blocking 一覧を無音で捨てず、下記を修正対象として提示します（difit CLI の出力契約変更を確認してください）`,
    );
  }
  if (
    result.blocking_threads.length === 0 &&
    !driftFailure &&
    !driftViolation &&
    contractViolations.length === 0
  ) {
    return undefined;
  }

  const lines = [
    "## difit の人間フィードバック（前回 collect_verdict の blocking_threads）",
    "",
    "以下は difit 上の未 resolve スレッドです。担当スコープに該当するものを修正してください。taxonomy / blocking は Rust 判定の値をそのまま使う。resolve 可否は taxonomy == human で判断する。",
    "want（`💡 want`）は人間 reply が付いたものだけが blocking_threads に現れる（人間が対話を求めた昇格分のみ修正対象）。",
    "",
  ];

  if (contractViolations.length > 0) {
    lines.push("## ⚠️ difit 出力の契約違反", "");
    for (const violation of contractViolations) {
      lines.push(violation, "");
    }
  }

  if (driftViolation) {
    // 契約違反（選択ドリフトの解釈不能）は executor では解消できない。
    // driftFailure と同じく resolve 禁止と復旧依頼を明示する。
    lines.push(
      "## ⚠️ difit の選択状態を検証できません（契約違反）",
      "",
      driftViolation,
      "",
      "選択状態を確認できないため、executor は `mt difit resolve` を行わず、オーケストレーター経由で difit CLI の出力スキーマ（selection_drift）の確認と `mt difit start <base-branch>` によるセッション復旧を依頼してください。",
      "",
    );
  }

  if (driftFailure) {
    // 選択ドリフト / 検知不能は executor では解消できない（人間による difit UI の
    // 選択復旧が必要）。人間 gate の description とあわせて、修正対象と誤認しない
    // よう原文で明示する。
    lines.push(
      driftFailure.detection === "detected"
        ? "## ⚠️ difit UI の選択ドリフト"
        : "## ⚠️ difit の選択状態を確認できません（検知不能）",
      "",
      describeDifitSelectionDrift(driftFailure),
      "",
      driftFailure.detection === "detected"
        ? "この状態で executor が `mt difit resolve` を実行してもゲートが読むセッションには反映されません。人間がセレクタを起動時の選択へ戻すまで resolve は行わず、オーケストレーター経由で復旧を依頼してください。"
        : "選択状態を確認できないため、executor は `mt difit resolve` を行わず、オーケストレーター経由で `mt difit start <base-branch>` による復旧を依頼してください。",
      "",
    );
  }

  for (const [index, thread] of result.blocking_threads.entries()) {
    const location = thread.file
      ? `${thread.file}${thread.line === undefined || thread.line === null ? "" : `:${typeof thread.line === "number" ? thread.line : `${thread.line.start}-${thread.line.end}`}`}`
      : "(file-level)";
    lines.push(`### ${index + 1}. ${location} (${thread.taxonomy ?? "unknown"})`);
    if (thread.taxonomy === "human") {
      // taxonomy == human は Rust 判定の人間コメントで、body がコメント本文そのもの。
      // replies は AI が注入しないため常に空で、resolve は人間が行う。
      lines.push(`人間コメント（原文）: ${thread.body}`);
    } else {
      lines.push(`指摘: ${thread.body}`);
      if (thread.replies && thread.replies.length > 0) {
        for (const reply of thread.replies) {
          lines.push(`人間 reply: ${reply}`);
        }
      } else {
        lines.push("人間 reply: (なし。未解決の指摘として確認する)");
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/// apply_feedback が統合した修正指示を保存するセッションファイル。
/// 内側ループ (autonomous_review_cycle) の先頭で組み立てられ、直後の execute_work が
/// 修正指示として読む。契約: `{ "items": [{ "source": "<findings|verdict|difit|gate:<stepKey>>", "body": "<原文>" }] }`。
/// 初回など修正ソースが無い実行では items: [] とする。source 語彙は
/// findings|verdict|difit|gate:<stepKey> のみ（check が allowlist 検証する）。
/// loop 外ゲート（identify_plan）の request_changes は巻き戻し不可のため
/// 統合対象外とし、gateAnswers に現れたら check が fail する。
const FEEDBACK_KEY = "feedback.json";

interface FeedbackItem {
  source: string;
  body: string;
}

/// feedback.json の body と期待原文の比較（前後空白の正規化後の厳密一致）。
/// includes 部分一致では「原文埋め＋任意追記」が pass し、追記文が executor への
/// 修正指示として混入する prompt-injection 経路になる。契約（`{"body": "<原文>"}`）
/// どおり原文そのものを要求し、正規化で吸収できる前後空白以外の差分は fail とする。
function feedbackBodyEquals(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

/// gate 回答値の抽出（型不正に fail-closed）。
/// GateAnswers の契約外形状（null・数値・value 非文字列等）は TypeError にせず
/// undefined を返し、呼び出し元の error/fail 経路へ載せる。
function gateAnswerValue(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer;
  if (isRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}

/// loop 内 human_gate の decision 回答値を読む（純粋関数）。
/// choice_with_input 回答は `{ value, input? }`、single_choice 回答は文字列。
/// 未回答（ゲート skip 時など）は undefined。
/// NOTE(ai-1): `questionKey = "decision"` 固定の未検証前提にしない。全 human_gate の
/// outcomeQuestionKey は現状 "decision" だが、将来の非 decision キーゲートの回答を
/// 読み落とさないよう、指定キー不在時は全設問キーを走査する（過剰な一般化は避け、
/// decision 優先・request_changes > abort > approve の順で fail-closed に1値を選ぶ
/// 最小限の走査に留める。def 参照による動的解決はしない）。
/// この走査は judge（単一ゲート読み）のフォールバック専用である。差し戻し収集
/// （collectGateReworkRequests）は outcome 回答のみを対象にし、def の
/// outcomeQuestionKey 解決（gateOutcomeQuestionKey）を使う。補助設問の
/// request_changes を拾う幽霊差し戻しを作らない。
function gateDecisionValue(
  gateAnswers: GateAnswers,
  stepKey: string,
  questionKey = "decision",
): string | undefined {
  const perGate = gateAnswers[stepKey];
  if (!perGate) return undefined;
  const direct = perGate[questionKey];
  if (direct !== undefined) {
    // 指定キー present 時の契約外形状は他キー走査で糊塗せず undefined（→error）にする。
    return gateAnswerValue(direct);
  }
  const values = new Set<string>();
  for (const ans of Object.values(perGate)) {
    const value = gateAnswerValue(ans);
    if (value === undefined) continue;
    values.add(value);
  }
  // 差し戻し（request_changes）の見落としが最も危険なため優先し、次に中断意図
  // （abort）、承認（approve）の順。未知値は決定的に1つ選ぶ（Set 挿入順の先頭）。
  for (const priority of ["request_changes", "abort", "approve"]) {
    if (values.has(priority)) return priority;
  }
  return values.values().next().value as string | undefined;
}

/// def 上の human_gate 定義から outcome 設問キーを解決する（ai-1）。
/// collectGateReworkRequests はこのキーに解決できたゲートでは outcome 回答のみを
/// 差し戻し対象にし、補助設問の request_changes を幽霊差し戻しとして拾わない。
/// def 未登録のゲート（旧定義残留・直 craft）は outcome 不明のため undefined を返し、
/// 呼び出し元は従来どおり decision 優先の全キー走査で検出する（見落としの fail-closed）。
/// loop 本体内を含む全ステップを走査する（knownWorkflowStepKeys と同じ写像）。
function gateOutcomeQuestionKey(stepKey: string): string | undefined {
  let found: string | undefined;
  const visit = (steps: StepDef[]): void => {
    if (found !== undefined) return;
    for (const step of steps) {
      if (step.type === "loop") {
        visit(step.body);
      } else if (step.type === "human_gate" && step.key === stepKey) {
        found = step.humanGate.outcomeQuestionKey;
        return;
      }
    }
  };
  visit(def.steps);
  return found;
}

/// apply_feedback が request_changes 差し戻しを統合する際の loop 外ゲート一覧。
/// loop 外で check が continue を返すとエンジンが fail-fast するため、loop 外ゲートに
/// request_changes を持たせない。gateAnswers に loop 外ゲートの request_changes が現れたら
/// （旧定義の残留・直 craft）、無音で捨てず apply_feedback の check が fail する。
const LOOP_OUTSIDE_GATE_KEYS = ["identify_plan"] as const;

/// gateAnswers 世代管理の skip 判定 registry（collectGateReworkRequests の唯一の参照先）。
/// loop 内 human_gate のうち condition を持つものは、step の condition と同一関数を
/// 登録する（散在する if 列挙にせず写像ドリフトを防ぐ）。loop 外ゲートは登録しない
/// （request_changes が現れたら stale 扱いで捨てず fail で検出する）。
/// 新規 loop 内ゲート追加時はこの表への登録が必須
/// （workflow.test.ts の更新強制テストが条件付き loop 内ゲート集合を固定する）。
const GATE_SKIP_CONDITIONS: Record<
  string,
  (ctx: { sessionDir: string; artifacts: ArtifactRecord[] }) => boolean
> = {
  await_human_review: (ctx) => isHumanReviewPhase(ctx),
};

/// feedback.json の items[].source 語彙。gate 差し戻しは `gate:<stepKey>` の一般形。
const FEEDBACK_SOURCE_PATTERN = /^(findings|verdict|difit|gate:[A-Za-z0-9_]+)$/;

/// gateAnswers を走査し、request_changes のゲートを列挙する（純粋関数）。
/// 固定ゲート一覧の走査にしない（契約の `gate:<stepKey>` 一般形どおり、将来の loop 内ゲート
/// 追加に追従する。loop 外ゲートの除外は LOOP_OUTSIDE_GATE_KEYS で行う）。
/// def に登録のあるゲートは outcome 設問キー（gateOutcomeQuestionKey）の回答のみを
/// 差し戻し対象にする。補助設問の request_changes は幽霊差し戻しになるため拾わない
/// （ai-1）。def 未登録のゲートは outcome 不明のため decision 優先の全キー走査で
/// 検出する（見落としの fail-closed。gateDecisionValue と同じ写像）。
/// NOTE(logic-1): skip されたゲートの stale 回答を残留させない。gateAnswers は loop 反復を
/// またいで最新回答を保持するため、前反復の request_changes が残っていても、当該反復で
/// ゲートが skip（condition false）なら差し戻し対象外とする。skip 判定は各ゲートの
/// condition と同一写像（await_human_review →
/// isHumanReviewPhase）で行い、写像ドリフトを作らない。ctx 省略時は旧来どおり全件収集
/// （呼び出し側は ctx を渡すこと。apply_feedback / execute_work / judge は渡す）。
function collectGateReworkRequests(
  gateAnswers: GateAnswers,
  ctx?: { sessionDir: string; artifacts: ArtifactRecord[] },
): { gateKey: string; questionKey: string; input: string | undefined }[] {
  const out: { gateKey: string; questionKey: string; input: string | undefined }[] = [];
  for (const gateKey of Object.keys(gateAnswers)) {
    // skip 判定（世代管理）。skip ゲートの stale request_changes は幽霊差し戻しになるため除外。
    // 判定は GATE_SKIP_CONDITIONS registry に一本化する（新規 loop 内ゲート追加時は登録必須）。
    if (ctx) {
      const skipWhen = GATE_SKIP_CONDITIONS[gateKey];
      if (skipWhen && !skipWhen(ctx)) continue;
    }
    const perGate = gateAnswers[gateKey];
    if (!perGate) continue;
    // 追加入力は文字列のみ受理する。契約外形状は undefined（欠落）として扱い、
    // 下流が「追加入力なし」の fail で止める（TypeError にしない）。
    const readInput = (ans: unknown): string | undefined =>
      typeof ans !== "string" && isRecord(ans) && typeof ans.input === "string"
        ? ans.input
        : undefined;
    const outcomeKey = gateOutcomeQuestionKey(gateKey);
    if (outcomeKey !== undefined) {
      // outcome 回答のみ対象。補助設問は幽霊差し戻しになるため走査しない。
      // outcome 不在・契約外形状・approve 等は差し戻し無しとして扱う。
      const ans = perGate[outcomeKey];
      if (ans === undefined) continue;
      if (gateAnswerValue(ans) !== "request_changes") continue;
      out.push({ gateKey, questionKey: outcomeKey, input: readInput(ans) });
      continue;
    }
    // def 未登録ゲートのフォールバック: decision 優先・全キー走査。request_changes を
    // 持つ設問が1つでもあれば差し戻し（見落としの fail-closed）。
    const entries = Object.entries(perGate);
    entries.sort(([a], [b]) => (a === "decision" ? -1 : 0) - (b === "decision" ? -1 : 0));
    for (const [qk, ans] of entries) {
      if (ans === undefined) continue;
      const value = gateAnswerValue(ans);
      if (value !== "request_changes") continue;
      out.push({ gateKey, questionKey: qk, input: readInput(ans) });
      break;
    }
  }
  return out;
}

/// findings.json を artifacts → セッションファイルの順で解決し、検証済みの値だけ返す。
function resolveReviewFindings(ctx: {
  sessionDir: string;
  artifacts: ArtifactRecord[];
}): FindingsJson | undefined {
  const findingsRaw =
    findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
  const findings = validateFindingsJson(findingsRaw);
  return findings.valid ? findings.parsed : undefined;
}

/// verdict.json を artifacts → セッションファイルの順で解決し、検証済みの値だけ返す。
function resolveReviewVerdict(ctx: {
  sessionDir: string;
  artifacts: ArtifactRecord[];
}): VerdictJson | undefined {
  const verdictRaw =
    findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY);
  const verdict = validateVerdictJson(verdictRaw);
  return verdict.valid ? verdict.parsed : undefined;
}

/// difit-check.json の blocking テキスト（body＋人間 reply）を解決する。
/// verdict.json が SoT のため verdict 側は resolveReviewVerdict を使い、difit 由来の
/// feedback（source=difit）の余剰検査にのみ使う。欠落・不正時は空（期待なし）。
function resolveDifitBlocking(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): {
  available: boolean;
  texts: string[];
} {
  const raw =
    findArtifactText(ctx.artifacts, DIFIT_CHECK_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, DIFIT_CHECK_KEY);
  const parsed = parseDifitCheck(raw);
  if (!parsed) return { available: false, texts: [] };
  const texts: string[] = [];
  for (const thread of parsed.blocking_threads) {
    if (thread.body.trim() !== "") texts.push(thread.body);
    const replies = (thread as { replies?: unknown }).replies;
    if (Array.isArray(replies)) {
      for (const reply of replies) {
        if (typeof reply === "string" && reply.trim() !== "") texts.push(reply);
      }
    }
  }
  return { available: true, texts };
}

/// ワークフロー定義の全ステップキー（loop 本体内を含む）。feedback.json の
/// `gate:<stepKey>` の実在確認に使う（`gate:fake_gate` 等の偽 source 混入を fail にする）。
function knownWorkflowStepKeys(): Set<string> {
  const keys = new Set<string>();
  const visit = (steps: StepDef[]): void => {
    for (const step of steps) {
      keys.add(step.key);
      if (step.type === "loop") visit(step.body);
    }
  };
  visit(def.steps);
  return keys;
}

/// verdict blocking の被覆テキスト（body＋人間 reply）。verdict.json が SoT のため、
/// blocking の原文被覆はこの一覧で行う（空 replies は含めない）。
function verdictBlockingTexts(verdict: VerdictJson): string[] {
  const out: string[] = [];
  for (const thread of verdict.blocking_threads) {
    if (thread.body.trim() !== "") out.push(thread.body);
    const replies = (thread as { replies?: unknown }).replies;
    if (Array.isArray(replies)) {
      for (const reply of replies) {
        if (typeof reply === "string" && reply.trim() !== "") out.push(reply);
      }
    }
  }
  return out;
}

/// feedback.json の items に対する双方向の被覆検証（純粋関数）。
/// 期待集合⊆実績集合（欠落検出）と実績集合⊆期待集合（余剰・捏造検出）の両方向を行う。
/// body と期待原文の突合は feedbackBodyEquals（正規化後厳密一致）で行う。
/// includes 部分一致では「原文埋め＋任意追記」が pass する後退になるため使わない。
/// 空 items の素通り防止はこの一般形に含める（期待があれば空でも fail、期待なしの空は pass）。
/// 呼び出し元: apply_feedback の check（厳密・全文被覆）、execute_work の check
/// （軽量・source 対応。原文被覆の厳密検証は apply_feedback が担う）。
/// 期待の解決: findings（must 詳細のみ必須・should/want は任意）・verdict（blocking 全文）・difit（blocking 全文）。
/// should/want 詳細は自律対象外のため、findings 側では必須化しない（有っても無くてもよい）。
/// want 詳細は人間 reply 付きのみ blocking に現れるため、findings 側では要求しない。
function verifyFeedbackItems(
  items: FeedbackItem[],
  expected: FeedbackCoverageExpected,
  opts: { strictBodyCoverage: boolean },
): { status: "pass" | "fail"; reasons: string[] } {
  const reasons: string[] = [];
  const bySource = (source: string): FeedbackItem[] => items.filter((i) => i.source === source);

  // 実績→期待（余剰・捏造の検出）。allowlist 通過だけでは偽 body 混入が素通りする。
  for (const [index, item] of items.entries()) {
    if (item.source.startsWith("gate:")) {
      const key = item.source.slice("gate:".length);
      if (!expected.knownStepKeys.has(key)) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}].source が未知のゲートです: ${item.source}（ワークフロー定義に存在しない stepKey）`,
        );
        continue;
      }
      const request = expected.gateInputs.find((r) => r.gateKey === key);
      if (!request) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (${item.source}) に対応する gate 差し戻しがありません。余剰の混入として fail とする`,
        );
        continue;
      }
      if (opts.strictBodyCoverage && !feedbackBodyEquals(item.body, request.input)) {
        reasons.push(
          `${key} の request_changes 追加入力が feedback.json の items（source=gate:${key}）に原文のまま含まれていません。差し戻しの欠落として fail とする`,
        );
      }
    } else if (item.source === "findings") {
      if (!expected.findingsAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=findings) に対応する findings.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        expected.findingDetails.length === 0 ||
        (opts.strictBodyCoverage &&
          !expected.findingDetails.some((f) => feedbackBodyEquals(item.body, f.detail)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=findings) の body が findings.json のいずれの指摘詳細とも一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    } else if (item.source === "verdict") {
      if (!expected.verdictAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=verdict) に対応する verdict.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        expected.verdictTexts.length === 0 ||
        (opts.strictBodyCoverage &&
          !expected.verdictTexts.some((t) => feedbackBodyEquals(item.body, t)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=verdict) の body が verdict.json の blocking と一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    } else if (item.source === "difit") {
      if (!expected.difitAvailable && !expected.verdictAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=difit) に対応する difit-check.json / verdict.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        (expected.difitTexts.length === 0 && expected.verdictTexts.length === 0) ||
        (opts.strictBodyCoverage &&
          !expected.difitTexts.some((t) => feedbackBodyEquals(item.body, t)) &&
          !expected.verdictTexts.some((t) => feedbackBodyEquals(item.body, t)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=difit) の body が difit / verdict の blocking と一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    }
  }

  // 期待→実績（欠落の検出）。items 非空でも must 件数分・blocking 被覆を検証する。
  // should/want は自律対象外のため必須化しない（must 修正に起因する新規 must 発生での
  // 発散を断つ。should/want が feedback に有っても無くてもよい）。
  if (opts.strictBodyCoverage) {
    for (const { gateKey, input } of expected.gateInputs) {
      // 実績→期待側で既に報告済みの gate は重複報告しない（対応 item が無い場合のみ）。
      if (bySource(`gate:${gateKey}`).some((i) => feedbackBodyEquals(i.body, input))) continue;
      if (!reasons.some((r) => r.includes(gateKey) && r.includes("原文のまま"))) {
        reasons.push(
          `${gateKey} の request_changes 追加入力が feedback.json の items（source=gate:${gateKey}）に原文のまま含まれていません。差し戻しの欠落として fail とする`,
        );
      }
    }
    for (const f of expected.findingDetails) {
      if (f.severity !== "must") continue;
      if (bySource("findings").some((i) => feedbackBodyEquals(i.body, f.detail))) continue;
      reasons.push(
        `findings[${f.index}] (${f.severity}) の指摘詳細が feedback.json の items（source=findings）に原文のまま含まれていません。指摘の欠落として fail とする`,
      );
    }
    for (const [i, text] of expected.verdictTexts.entries()) {
      if (bySource("verdict").some((item) => feedbackBodyEquals(item.body, text))) continue;
      reasons.push(
        `verdict blocking[${i}] が feedback.json の items（source=verdict）に原文のまま含まれていません。blocking の欠落として fail とする`,
      );
    }
  }

  return reasons.length > 0 ? { status: "fail", reasons } : { status: "pass", reasons: [] };
}

/// verifyFeedbackItems への期待入力（apply_feedback と execute_work で共有）。
/// 両 check が別々に期待を組み立てると写像ドリフト（片方だけ被覆が緩い）を作るため、
/// 組み立ては buildFeedbackCoverageExpected に一本化する（logic-2）。
interface FeedbackCoverageExpected {
  gateInputs: { gateKey: string; input: string }[];
  findingDetails: { index: number; severity: string; detail: string }[];
  verdictTexts: string[];
  difitTexts: string[];
  knownStepKeys: Set<string>;
  findingsAvailable: boolean;
  verdictAvailable: boolean;
  difitAvailable: boolean;
}

/// feedback.json の被覆検証に使う期待集合を解決する。
/// findings（must 詳細のみ必須・should/want は任意）・verdict（blocking 全文）・difit（blocking 全文）と
/// gate 差し戻し（loop 外除外・追加入力あり のみ）を束ねる。apply_feedback の check
/// （厳密・全文被覆）と execute_work の check（TOCTOU・差し替えの再検証）が同じ
/// 期待を使い、apply 通過後の差し替え・dummy すり替えを execute 側でも fail にする。
function buildFeedbackCoverageExpected(
  ctx: { sessionDir: string; artifacts: ArtifactRecord[] },
  requests: { gateKey: string; input: string | undefined }[],
): FeedbackCoverageExpected {
  const findings = resolveReviewFindings(ctx);
  const verdict = resolveReviewVerdict(ctx);
  const difit = resolveDifitBlocking(ctx);
  return {
    gateInputs: requests
      .filter(
        (r) =>
          !(LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(r.gateKey) &&
          r.input !== undefined &&
          r.input.trim() !== "",
      )
      .map((r) => ({ gateKey: r.gateKey, input: (r.input as string).trim() })),
    findingDetails: findings
      ? findings.findings.map((f, index) => ({
          index,
          severity: f.severity,
          detail: f.detail,
        }))
      : [],
    verdictTexts: verdict ? verdictBlockingTexts(verdict) : [],
    difitTexts: difit.texts,
    knownStepKeys: knownWorkflowStepKeys(),
    findingsAvailable: findings !== undefined,
    verdictAvailable: verdict !== undefined,
    difitAvailable: difit.available,
  };
}

/// must=0 または自律上限で通常の人間レビューへ渡す。
function isHumanReviewPhase(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): boolean {
  const findingsRaw =
    findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
  const findingsResult = validateFindingsJson(findingsRaw);
  if (!findingsResult.valid || !findingsResult.parsed) return false;
  return (
    findingsResult.parsed.counts.must === 0 || findingsResult.parsed.round >= REVIEW_ROUND_LIMIT
  );
}

/// 人間ゲート回答を loop の判定へ写像する。
function decideGateRework(
  value: string | undefined,
): "pass" | "continue" | "abort" | "unknown" | "missing" {
  if (value === undefined) return "missing";
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "abort";
  return "unknown";
}

function judgeGateRework(
  value: string | undefined,
  opts: { gateKey: string; loopKey: string; headKey: string },
): CheckResult {
  const decision = decideGateRework(value);
  if (decision === "missing") {
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} が実行されましたが gateAnswers に回答がありません。ゲート未 confirmed のまま判定ステップへ進んでいます`,
      ],
    };
  }
  if (decision === "pass") {
    return { status: "pass", reasons: [`${opts.gateKey} approved — proceed`] };
  }
  if (decision === "abort") {
    // 中断は値語彙の想定外ではない（正規選択肢）。未知値 fail に混ぜると中断意図が
    // 語彙エラーにすり替わるため、専用の error で分離する。CheckResult に abort 値は
    // 無いため、error で中断意図を記録して止める（round 前進・巻き戻しなし）。
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません。difit セッションの後始末が必要な場合は \`mt difit done\`（冪等・exit 0）を手動実行してください`,
      ],
    };
  }
  if (decision === "unknown") {
    return {
      status: "fail",
      reasons: [
        `${opts.gateKey} の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は新エンジン契約で撤去済みのため request_changes を使ってください。互換受理はしない）`,
      ],
    };
  }
  return {
    status: "continue",
    reasons: [`${opts.gateKey} request_changes — rewind ${opts.loopKey} to ${opts.headKey}`],
  };
}

// plan-run 用: Issue body から effort を解析するヘルパ
// SoT は mt-plan-create の finalize が書く末尾 HTML コメントのみ:
// `<!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->`
// プロンプト記法 (width=... のばら撒き) や `width: ...` セクション記法は受理しない。
function parseEffortFromIssueBody(body: string | undefined): {
  width?: string;
  depth?: string;
} {
  if (!body || !/<!--\s*effort:/i.test(body)) return {};
  return effortFromIssueBody(body);
}

/// Issue body に effort コメントらしきものがあるが、厳密な width+depth を
/// 満たさない場合に true。欠落（コメントなし）と区別し、不正時は medium 化せず止める。
function hasInvalidEffortComment(body: string | undefined): boolean {
  if (!body) return false;
  const blocks = [...body.matchAll(/<!--\s*effort:.*?-->/gis)].map((m) => m[0]);
  if (blocks.length === 0) return false;
  try {
    effortFromIssueBody(body);
    return false;
  } catch {
    return true;
  }
}

function ensureEffortFromIssueBody(
  sessionDir: string,
  artifacts: ArtifactRecord[],
): { width: string; depth: string } | undefined {
  const issueBody = (() => {
    try {
      const t = findArtifactText(artifacts, "issue-body.md", sessionDir);
      if (t) return t;
    } catch {}
    return (
      readSessionFile(sessionDir, "issue-body.md") ??
      readSessionFile(sessionDir, "issue-body.md".replace(".md", ".txt"))
    );
  })();
  const effort = parseEffortFromIssueBody(issueBody);
  if (effort.width && effort.depth) {
    // check は純粋判定が契約のためファイル生成は行わない (生成は run_reviewers.beforeStep の task 側で実施)
    return { width: effort.width, depth: effort.depth };
  }
  return undefined;
}

const def: WorkflowDef = {
  id: "mt-plan-run",
  description:
    "GitHub Issueベースの計画を選択し実行して履歴を更新するワークフロー。実行・検証・修正サイクルを管理し計画を完遂させる。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
  },

  steps: [
    // -------------------------------------------------------------------
    // Step 1: 計画の特定
    // -------------------------------------------------------------------
    {
      key: "identify_plan",
      phase: "計画の特定",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      humanGate: {
        presentArtifacts: [],
        outcomeQuestionKey: "decision",
        // loop 外ゲートのため選択肢は approve/abort のみとし、request_changes は持たせない。
        // request_changes を選んでも巻き戻しは起きず記録上通過するだけの未配線選択肢になるため、
        // 計画の特定をやり直す場合は abort＋再実行へ誘導する（loop 外の continue は fail-fast）。
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "計画の特定をやり直す場合は「中断」を選び、中断後に正しい計画番号で再実行してください。このゲートは loop 外のため request_changes による巻き戻しはできません",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "計画を特定した",
                desc: "Issue番号を確認し次へ進む",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断" },
            ],
          },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },

    // -------------------------------------------------------------------
    // Step 2: 実行開始（refined → in-progress）
    // -------------------------------------------------------------------
    {
      key: "start_execution",
      phase: "実行開始",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          // NOTE(prompt-type): 要素は行頭#なしの通常文のみ。見出し追加時はSection化すること
          // 巨大な単一リテラルは ValidateSpec の再帰展開で TS2589 を起こすため、
          // PromptItem 配列に3分割して組み立てる（string[] widen はしない）。
          const verifyPlan: PromptItem<3>[] = [
            "1. ユーザーが指定した計画 Issue 番号 `<number>` を確認する（初回ヒアリングで取得済み）",
            "",
            "2. Issue の存在・状態を検証する:",
            "",
            "```bash",
            "gh issue view <number> --json state,labels,number,title,url",
            "```",
            "",
            "- `kind/plan` label が付与されていることを確認",
            "- `state` が `OPEN` であることを確認",
            "",
            "3. `list-plans.ts` で status を確認し、`refined` または `in-progress` であることを検証する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "mt-plan-list-plans.ts")}`,
            "```",
            "",
            "- `draft` なら `mt-plan-create` へ案内して中断",
            "- `done` なら「完了済み。再開しますか？」と確認",
            "",
            "4. GitHub Sub Issue を確認する。Sub Issue を持つ親計画は実行できないため、子計画を選び直して中断する:",
            "",
            "```bash",
            "gh api repos/<owner>/<repo>/issues/<number>/sub_issues",
            "```",
            "",
          ];
          const transitionAndRead: PromptItem<3>[] = [
            "5. `transition-plan.ts` を使って `refined` → `in-progress` に遷移する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "../_shared/mt-plan-transition-plan.ts")} <number> in-progress`,
            "```",
            "",
            "既に `in-progress` の場合はスキップする。",
            "",
            "6. Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:",
            "",
            "```bash",
            "gh issue view <number> --json body",
            "```",
            "",
            `読み込んだ body を ${ctx.sessionDir}/issue-body.md にも保存する。`,
            "",
          ];
          const reportAndSave: PromptItem<3>[] = [
            "7. 読み込んだ内容の要点を報告する:",
            "   - 完了条件の数と概要",
            "   - 主要な方針",
            "   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）",
            "",
            "8. 計画番号と Issue body を保存する。計画番号はセッションディレクトリの `plan-number.txt` に書き出し、report 時の `artifacts` に以下を含めること（申告漏れは check で fail になる）:",
            "```json",
            `[{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}, {"key": "issue-body.md", "path": "${ctx.sessionDir}/issue-body.md"}]`,
            "```",
          ];
          return buildStepPrompt({
            purpose: [
              "計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。",
            ],
            criteria: [],
            approach: [...verifyPlan, ...transitionAndRead, ...reportAndSave],
            output: [],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          });
        },
      },
      // 統一最低ライン: 計画番号・Issue body の申告・実在・形式を強制
      check: (ctx: CheckCtx): CheckResult => {
        return requireStepArtifacts(ctx, [
          { key: "plan-number.txt", form: "text", pattern: /^[0-9]+$/ },
          {
            key: "issue-body.md",
            form: "markdown",
            sections: ["## ✅ 完了条件", "## 🧭 方針", "## 🐢 履歴"],
          },
        ]);
      },
    },

    // -------------------------------------------------------------------
    // Step 2.5: ドキュメント転記
    // -------------------------------------------------------------------
    {
      key: "transcribe_docs",
      phase: "ドキュメント転記",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      condition: (ctx: ConditionCtx): boolean => {
        const body = findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
        return body?.includes("## 📄 ドキュメント") ?? false;
      },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: [
              "計画 Issue の `## 📄 ドキュメント` セクションをリポジトリの実ファイルへ転記する。",
            ],
            criteria: [],
            approach: [
              {
                title: "1. ドキュメントセクションの抽出",
                content: [
                  `セッションディレクトリの issue-body.md から \`## 📄 ドキュメント\` セクションを抽出する。`,
                  "",
                ],
              },
              {
                title: "2. 各ブロックの書き出し",
                content: [
                  "各 `### <リポジトリ相対パス>` 見出しと直下のコードフェンス（ファイル全文）を、指定パスへ書き出す。",
                  "",
                  "- ADR 連番が既存ファイルと衝突する場合は、次の空き番号へリネームして書き出す",
                  "- 既存ファイル（主に `CONTEXT.md`）がある場合は既存内容を読み、計画側の内容を正としてマージする（`_Avoid_` ルールに従う）",
                  "- 書き出しは未コミット差分として残す（コミットは行わない）",
                  "",
                ],
              },
              {
                title: "3. 書き出し結果の報告",
                content: [
                  "書き出したファイル一覧（パス・新規/更新・マージの有無）を報告する。",
                  "",
                ],
              },
            ],
            output: [
              "書き出したファイルの一覧をセッションディレクトリの `transcribed-docs.json` に保存する（パスはリポジトリルート相対）:",
              "",
              "```json",
              '[{ "path": "docs/adr/0002-xxx.md", "action": "new" | "update" | "merge" }]',
              "```",
              "",
              "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
              "```json",
              `{"key": "transcribed-docs.json", "path": "${ctx.sessionDir}/transcribed-docs.json"}`,
              "```",
            ],
          });
        },
      },
      // 統一最低ライン: 転記一覧の申告・実在・スキーマ + 転記先ファイルの実在を強制
      check: (ctx: CheckCtx): CheckResult => {
        const result = requireStepArtifacts(ctx, [
          { key: "transcribed-docs.json", form: "json", minItems: 1, itemKeys: ["path", "action"] },
        ]);
        if (result.status !== "pass") return result;
        const raw = fs.readFileSync(join(ctx.sessionDir, "transcribed-docs.json"), "utf-8");
        const transcribed = JSON.parse(raw) as { path: unknown }[];
        const reasons: string[] = [];
        for (const entry of transcribed) {
          if (typeof entry.path !== "string" || !fs.existsSync(entry.path)) {
            reasons.push(`transcribed file does not exist: ${String(entry.path)}`);
          }
        }
        return reasons.length > 0
          ? { status: "fail", reasons }
          : { status: "pass", reasons: [`${transcribed.length} file(s) transcribed`] };
      },
    },

    // -------------------------------------------------------------------
    // 内外とも最大5回。自律上限は通常通過で人間レビューへ渡す。
    // 人間側が全回差し戻した場合だけ onExhausted によりエンジンが paused にする。
    // effort.round は normalize 前に ctx.loop.iteration から設定するため、
    // 外側巻き戻しによる内側 iteration=1 への初期化が予算再付与になる。
    {
      key: "human_review_cycle",
      phase: "人間サイクル",
      type: "loop",
      maxIterations: REVIEW_ROUND_LIMIT,
      onExhausted: "escalate",
      body: [
        {
          key: "autonomous_review_cycle",
          phase: "自律サイクル",
          type: "loop",
          maxIterations: REVIEW_ROUND_LIMIT,
          onExhausted: "escalate",
          body: [
            // -------------------------------------------------------------------
            // Step 2.8: 指摘統合（plan-run 所有・自律 loop 先頭）
            //         findings / verdict / difit の指摘と loop 内人間ゲートの request_changes
            //         追加入力を統合し、修正指示を feedback.json へ組み立てる。
            //         修正作業自体は行わず、execute_work の executor SubAgent に委譲する。
            //         リポジトリのファイル編集は行わない。
            // -------------------------------------------------------------------
            {
              key: "apply_feedback",
              phase: "指摘統合",
              type: "task",
              maxRetries: 1,
              onFail: { action: "escalate" },
              task: {
                action: "orchestrate",
                buildPrompt: (ctx: PromptCtx) => {
                  const gateFeedbacks: string[] = [];
                  // skip ゲートの stale 回答は同一写像で除外し、幽霊差し戻しを prompt に載せない。
                  for (const { gateKey, input } of collectGateReworkRequests(
                    ctx.gateAnswers,
                    ctx,
                  )) {
                    if ((LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(gateKey)) {
                      gateFeedbacks.push(
                        `- ${gateKey}: (⚠️ loop 外ゲートの差し戻しは巻き戻し不可のため統合できない。apply_feedback の check が fail で停止する)`,
                      );
                      continue;
                    }
                    if (input === undefined || input.trim() === "") {
                      // 追加入力の欠落は "(追加入力なし)" で捏造しない。check が fail で止めるため、
                      // ここでは異常の存在だけを記録する（異常系の正常系への偽装をしない）。
                      gateFeedbacks.push(
                        `- ${gateKey}: (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、apply_feedback の check が fail で停止する)`,
                      );
                      continue;
                    }
                    gateFeedbacks.push(`- ${gateKey}: ${input}`);
                  }
                  return buildStepPrompt({
                    purpose: [
                      "前回レビューサイクルの指摘を統合し、修正指示を feedback.json へ組み立てる。修正作業自体は行わない（execute_work の executor SubAgent が行う）。",
                    ],
                    criteria: [],
                    approach: [
                      {
                        title: "人間ゲートの差し戻し（gateAnswers。原文のまま扱う）",
                        content: [
                          ...(gateFeedbacks.length > 0
                            ? gateFeedbacks
                            : ["- (なし。初回実行または前回 approve)"]),
                          "",
                        ],
                      },
                      {
                        title: "手順",
                        content: [
                          "1. セッションディレクトリの `findings.json` を読み、must の全指摘を抽出する（should / want は自律対象外のため統合しない。feedback に含めても除外してもよい）",
                          "2. セッションディレクトリの `verdict.json` と `difit-check.json` を読み、`blocking_threads[].body` と `replies`（人間 reply）を抽出する（`verdict.json` が SoT）",
                          "3. 上記と「人間ゲートの差し戻し」を統合し、重複を除いて修正指示を組み立てる（要約・省略・taxonomy の変更をしない。人間コメント・人間 reply は原文のまま）",
                          '4. 組み立てた修正指示をセッションディレクトリの `feedback.json` に保存する。契約: `{"items": [{"source": "<findings|verdict|difit|gate:<stepKey>>", "body": "<原文>"}]}`。修正ソースが無い実行では `{"items": []}` とする',
                          "",
                          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                          "```json",
                          `{"key": "feedback.json", "path": "${ctx.sessionDir}/feedback.json"}`,
                          "```",
                        ],
                      },
                    ],
                    output: [],
                    policy: [
                      "- リポジトリのファイルを編集しない（修正作業は execute_work の executor が行う）",
                      "- workflow.db に触れない（巻き戻しは loop の continue が行う）",
                    ],
                  });
                },
              },
              check: (ctx: CheckCtx): CheckResult => {
                if (ctx.attemptResult.status !== "completed") {
                  return {
                    status: "error",
                    reasons: [ctx.attemptResult.errors ?? "apply_feedback failed"],
                  };
                }
                const base = requireStepArtifacts(ctx, [{ key: FEEDBACK_KEY, form: "json" }]);
                if (base.status !== "pass") return base;
                const raw =
                  findArtifactText(ctx.artifacts, FEEDBACK_KEY, ctx.sessionDir) ??
                  readSessionFile(ctx.sessionDir, FEEDBACK_KEY);
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw ?? "null");
                } catch (error) {
                  return {
                    status: "fail",
                    reasons: [`${FEEDBACK_KEY} を JSON として読めません: ${String(error)}`],
                  };
                }
                if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
                  return {
                    status: "fail",
                    reasons: [`${FEEDBACK_KEY} は {"items": [...]} の形式である必要があります`],
                  };
                }
                const items: FeedbackItem[] = [];
                for (const [index, item] of parsed.items.entries()) {
                  if (
                    !isRecord(item) ||
                    typeof item.source !== "string" ||
                    item.source.trim() === ""
                  ) {
                    return {
                      status: "fail",
                      reasons: [
                        `${FEEDBACK_KEY}.items[${index}].source が空または文字列ではありません`,
                      ],
                    };
                  }
                  if (typeof item.body !== "string" || item.body.trim() === "") {
                    return {
                      status: "fail",
                      reasons: [
                        `${FEEDBACK_KEY}.items[${index}].body が空または文字列ではありません`,
                      ],
                    };
                  }
                  items.push({ source: item.source, body: item.body });
                }
                // gateAnswers との突合（shape のみ検証では捏造・欠落・別ソース混入が素通りする）。
                // skip ゲートの stale 回答は同一写像で除外する（世代管理。幽霊差し戻しの強制を防ぐ）。
                const requests = collectGateReworkRequests(ctx.gateAnswers, ctx);
                for (const { gateKey, input } of requests) {
                  if ((LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(gateKey)) {
                    return {
                      status: "fail",
                      reasons: [
                        `${gateKey} は loop 外ゲートのため request_changes を巻き戻しできず、feedback.json へ統合できない（記録上通過するだけになり差し戻しが無音消失する）。abort して再実行するか、loop 内ゲートで差し戻してください`,
                      ],
                    };
                  }
                  if (input === undefined || input.trim() === "") {
                    return {
                      status: "fail",
                      reasons: [
                        `${gateKey} の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする（"(追加入力なし)" の捏造はしない）`,
                      ],
                    };
                  }
                }
                // source 語彙の allowlist（捏造・別ソース混入の素通りを塞ぐ）。
                for (const [index, item] of items.entries()) {
                  if (!FEEDBACK_SOURCE_PATTERN.test(item.source)) {
                    return {
                      status: "fail",
                      reasons: [
                        `${FEEDBACK_KEY}.items[${index}].source が未知の語彙です: ${item.source}（findings|verdict|difit|gate:<stepKey> のいずれか）`,
                      ],
                    };
                  }
                }
                // 双方向の被覆検証（期待⊆実績・実績⊆期待）。items 非空でも findings must
                // 件数分・verdict blocking 被覆を検証し、ダミー混入・must 欠落を塞ぐ。
                // 空 items ガードはこの一般形に含める: 期待（gate 差し戻し / findings must /
                // verdict blocking）があるのに items が空なら fail。修正ソースなしの初回実行は
                // pass のまま。should-only は自律対象外のため items=[] で pass（should/want は任意）。
                // want 詳細は人間 reply 付きのみ blocking に現れるため findings 側では要求しない。
                // 期待の組み立ては execute_work と共有（buildFeedbackCoverageExpected）し、
                // 写像ドリフトを作らない。
                const coverage = verifyFeedbackItems(
                  items,
                  buildFeedbackCoverageExpected(ctx, requests),
                  { strictBodyCoverage: true },
                );
                if (coverage.status !== "pass") return coverage;
                return {
                  status: "pass",
                  reasons: [
                    items.length === 0
                      ? `${FEEDBACK_KEY} を検証しました（統合する指摘なし）`
                      : `${FEEDBACK_KEY} を検証しました（${items.length} 件の修正指示）`,
                  ],
                };
              },
            },

            // -------------------------------------------------------------------
            // Step 3: 作業実行（executor SubAgent 委譲・並列）
            // -------------------------------------------------------------------
            {
              key: "execute_work",
              phase: "作業実行",
              type: "task",
              maxRetries: 3,
              onFail: { action: "escalate" },
              task: {
                action: "orchestrate",
                buildPrompt: (ctx: PromptCtx) => {
                  const difitFeedback = formatDifitFeedback(ctx);
                  return buildStepPrompt({
                    purpose: [
                      "計画 Issue の `## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針` に従って作業を実行する。",
                      "作業の実施は必ず `mt-plan-work-executor` SubAgent に委譲する。オーケストレーター自身はリポジトリのファイル編集を行わず、ミッションの割り振り・進行管理・Issue body 更新に専念する。",
                    ],
                    criteria: [],
                    approach: [
                      {
                        title: "修正ソース（再実行時に適用）",
                        content: [
                          "自律ループの先頭（apply_feedback）から戻ってきた場合、以下のソースから修正指示を統合して executor SubAgent に渡す:",
                          "",
                          "1. **feedback.json の統合指示**（apply_feedback が組み立てた修正指示。findings must / verdict / difit の指摘と人間ゲートの request_changes 追加入力を原文のまま含む。再実行時はこのファイルを最初に読む）",
                          "2. **findings.json の must 指摘のみ**（run_reviewers の SubAgent レビューで検出された必須修正。should / want は自律対象外）",
                          "3. **difit の blocking_threads のうち must 由来**（`difit-check.json` / `verdict.json` の blocking_threads。未 resolve スレッドを人間 reply 込みで含むが、should / want は自律対象外）",
                          "",
                          "各ソースの存在確認:",
                          "- セッションディレクトリの `feedback.json` を読み、apply_feedback の統合指示を抽出する（feedback がある場合は、オーケストレーター自身の判断で握り潰さず executor への修正指示に原文のまま含める）",
                          "- セッションディレクトリの `findings.json` を読み、must 指摘を抽出する（should / want は自律対象外のため executor への修正指示に含めない）",
                          "- セッションディレクトリの `verdict.json` と `difit-check.json` を読み、`blocking_threads[].body` と `replies`（人間 reply）を抽出する（`verdict.json` が SoT。must 由来のみ修正対象）",
                          "- 存在しないファイルは無視する（初回実行時は修正ソースなし）",
                          "",
                          "should / want 指摘の扱い:",
                          "- should / want は自律対象外のため修正しない（should 修正に起因する新規 must 発生での発散を断つ）",
                          "- should / want スレッドは未 resolve のまま残し、人間フェーズの判断に委ねる",
                          "- must 修正に付随して should / want 箇所が偶発的に解消されることは許容するが、should / want 狙いの編集は禁止する",
                          "",
                          "修正指示の仕分け:",
                          "- 指摘を該当ミッションのスコープで仕分けし、担当の executor SubAgent に修正指示として渡す",
                          "- must のみ対応対象。should / want（人間 reply 付きを含む）は対応対象外",
                          "- difit の人間コメント・人間 reply はテキスト原文として executor に渡し、要約・省略・taxonomy の変更をしない",
                          "",
                          "対応完了時のスレッド resolve:",
                          "- executor は対応した AI 指摘のスレッドを `mt difit resolve <threadId>` で resolve する（state の読み取り → 記録 pid が記録 port を LISTEN していることの照合 → 選択固定セッションへの resolve までを 1 コマンドで行い、人間コメントのスレッドは拒否される。`.difit/difit-review.json` の port を直接読んで `difit` CLI を叩かない）",
                          "- must（taxonomy issue）: 対応したスレッドを resolve する",
                          "- should（taxonomy question）/ want: 自律では resolve しない。未 resolve のまま残す",
                          "- 人間コメント（`taxonomy` == `human`）: resolve しない。修正が必要な場合も resolve は人間に委ね、未 resolve のまま残す",
                          "",
                          // difit 由来の動的文字列は素通し spread せず、原文維持のまま
                          // コードフェンスで隔離して Section content へ渡す
                          ...(difitFeedback ? [isolateDifitFeedback(difitFeedback), ""] : []),
                        ],
                      },
                      {
                        title: "1. ミッションの読み取り",
                        content: [
                          "Issue body（`gh issue view <number> --json body`）から `## 🧩 ミッション` セクションを読み取る（必須）:",
                          "",
                          "- `### 実行順` の Wave 定義と各 `### M<n>: <名前>` ミッションのスコープ・完了条件を把握する",
                          "- セクションがない場合: 計画不備として実行を停止する（計画全体を 1 ミッションとして扱うフォールバックはしない）。当該番号のIssueが存在する場合は `mt-plan-update`、存在しない新規の場合は `mt-plan-create` で追記してから再実行する",
                          "",
                        ],
                      },
                      {
                        title: "2. executor SubAgent の起動",
                        content: [
                          'Wave 方式に従って、Task ツールで `subagent_type = "mt-plan-work-executor"` を起動する:',
                          "",
                          "- 同じ Wave 内のミッションは並列起動する（最大 5 同時）。同一メッセージで複数の Task ツール呼び出しを行う",
                          "- 異なる Wave は番号順に直列実行する（Wave 2 は Wave 1 の全ミッション完了後に開始）",
                          "- 各 SubAgent に渡す情報:",
                          "  - 計画 Issue body 全文（完了条件・方針・アウトプットの判断に必要）",
                          "  - 担当ミッション定義（ID・名前・スコープ・完了条件番号・Wave 所属）",
                          "  - 修正指示（再実行時のみ: findings.json、verdict.json/difit-check.json の blocking_threads / 人間 reply の該当指摘）",
                          "",
                        ],
                      },
                      {
                        title: "executor の完了報告契約",
                        content: [
                          "各 executor は、作業結果を次の構造化 JSON オブジェクトとして必ず返す:",
                          "```json",
                          "{",
                          '  "changedFiles": ["<repository-relative-path>"],',
                          '  "checks": [{"command": "<command>", "result": "<result>"}],',
                          '  "unresolvedIssues": []',
                          "}",
                          "```",
                          "",
                        ],
                      },
                      {
                        title: "3. 完了報告の集約",
                        content: [
                          "- 全ミッションの完了報告（変更ファイル一覧・検証結果・未解決事項）を集約する",
                          "- 集約結果をセッションディレクトリの `execution-result.json` に保存する（executor 返却 JSON をミッション単位でマージ）:",
                          "",
                          "```json",
                          "{",
                          '  "changedFiles": ["<repository-relative-path>"],',
                          '  "checks": [{"command": "<command>", "result": "<result>"}],',
                          '  "unresolvedIssues": []',
                          "}",
                          "```",
                          "",
                          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                          "```json",
                          `{"key": "execution-result.json", "path": "${ctx.sessionDir}/execution-result.json"}`,
                          "```",
                          "",
                          "- ミッションがスコープ外変更の必要を報告した場合は、作業を止めてユーザーに計画修正を提案する",
                          '- いずれかのミッションが失敗した場合は report を `status: "failed"` とし、失敗内容を errors に含める',
                          "",
                        ],
                      },
                      {
                        title: "Issue body 更新（オーケストレーターが実施）",
                        content: [
                          "以下のタイミングで更新する:",
                          "- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行済み）",
                          "- 全ミッション完了後: `## 🐢 履歴` へミッションごとの変更内容と確認結果を追記",
                          "- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記",
                          "- 中断時: `## 🐢 履歴` または `## 🐿️ メモ` へ完了済みミッション・次回再開位置・残論点を残す",
                          "",
                          "更新前は必ず `gh issue view` で body を読み、他者の差分を上書きしない。",
                          "",
                          "`## 🐿️ メモ` の運用:",
                          "- `💭 背景:` … 前提・制約",
                          "- `🤔 論点:` … 未決事項・要確認事項",
                          "- `🧭 指針:` … 合意済み判断・運用ルール",
                          "- 未解決の論点は Done 前に解消・方針へ取り込み・スコープ外化のいずれかを行う",
                          "",
                          "```bash",
                          "gh issue edit <number> --repo <repo> --body-file <tmpfile>",
                          "```",
                        ],
                      },
                    ],
                    output: [],
                    policy: [
                      "- オーケストレーター自身がリポジトリのファイルを編集しない（作業は必ず executor SubAgent へ委譲）",
                      "- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する",
                      "- ユーザー承認前に `done` 化しない",
                      "- 全ミッションの完了前に次のステップへ進まない",
                    ],
                  });
                },
              },
              check: (ctx: CheckCtx): CheckResult => {
                if (ctx.attemptResult.status !== "completed") {
                  return {
                    status: "error",
                    reasons: [ctx.attemptResult.errors ?? "execute_work failed"],
                  };
                }
                // 統一最低ライン: executor 返却 JSON の集約物を成果物として強制。
                // 内容の妥当性検証は下流の reviewer/verdict（daemon 突合）に委譲する。
                // apply_feedback との接続: gate 差し戻しがあるのに feedback.json の items が
                // 空・不在なら、差し戻しが握り潰されるため fail（LLM の申告だけに頼らない最小限の接続）。
                // skip ゲートの stale 回答は同一写像で除外する（世代管理）。
                // NOTE(logic-2): source 存在のみでは apply 通過後の差し替え（TOCTOU）や
                // dummy すり替えが素通りする。gate 差し戻し・must / blocking 時は
                // apply_feedback と同じ期待（buildFeedbackCoverageExpected）で正規化後厳密一致の
                // 双方向被覆を再検証し、無関係 body のみの素通りを fail にする。
                // should/want は自律対象外のため needsFeedback・被覆必須に含めない。
                // 原文の厳密被覆の SoT は apply_feedback であり、ここでは接続の再検証として
                // 同じ verifyFeedbackItems を使う（写像ドリフトを作らない）。
                const reworkRequests = collectGateReworkRequests(ctx.gateAnswers, ctx).filter(
                  (r) => !(LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(r.gateKey),
                );
                const findingsForWork = resolveReviewFindings(ctx);
                const verdictForWork = resolveReviewVerdict(ctx);
                const needsFeedback =
                  reworkRequests.length > 0 ||
                  (findingsForWork !== undefined && findingsForWork.counts.must > 0) ||
                  (verdictForWork !== undefined && verdictForWork.blocking_threads.length > 0);
                if (needsFeedback) {
                  const feedbackRaw =
                    findArtifactText(ctx.artifacts, FEEDBACK_KEY, ctx.sessionDir) ??
                    readSessionFile(ctx.sessionDir, FEEDBACK_KEY);
                  let feedbackItems: FeedbackItem[] | undefined;
                  try {
                    const feedbackParsed: unknown = JSON.parse(feedbackRaw ?? "null");
                    feedbackItems =
                      isRecord(feedbackParsed) &&
                      Array.isArray(feedbackParsed.items) &&
                      feedbackParsed.items.every(
                        (entry: unknown) =>
                          isRecord(entry) &&
                          typeof entry.source === "string" &&
                          typeof entry.body === "string",
                      )
                        ? (feedbackParsed.items as FeedbackItem[])
                        : undefined;
                  } catch {
                    feedbackItems = undefined;
                  }
                  if (!feedbackItems || feedbackItems.length === 0) {
                    const what =
                      reworkRequests.length > 0
                        ? `gate 差し戻し（${reworkRequests.map((r) => r.gateKey).join(", ")}）`
                        : findingsForWork !== undefined && findingsForWork.counts.must > 0
                          ? `findings must=${findingsForWork.counts.must} should=${findingsForWork.counts.should}`
                          : `verdict blocking=${verdictForWork?.blocking_threads.length ?? 0}`;
                    return {
                      status: "fail",
                      reasons: [
                        `${what} があるのに ${FEEDBACK_KEY} の items が空または不在です。apply_feedback の統合指示が execute_work へ届いていません`,
                      ],
                    };
                  }
                  // gate 差し戻し・must・blocking の原文被覆を、apply_feedback と
                  // 同じ期待で再検証する（apply 通過後の差し替え・dummy すり替えの検出）。
                  const coverage = verifyFeedbackItems(
                    feedbackItems,
                    buildFeedbackCoverageExpected(ctx, reworkRequests),
                    { strictBodyCoverage: true },
                  );
                  if (coverage.status !== "pass") return coverage;
                }
                return requireStepArtifacts(ctx, [
                  {
                    key: "execution-result.json",
                    form: "json",
                    keys: ["changedFiles", "checks", "unresolvedIssues"],
                  },
                ]);
              },
            },

            // -------------------------------------------------------------------
            // Step 4: 検証強度解決（human_gate 廃止 — Issue body コメント or medium/medium の自動解決）
            //         SoT は mt-plan-create の Issue body 末尾 `<!-- effort: ... -->` のみ。
            //         プロンプト記法 width=... depth=... による上書きは受理しない。
            // -------------------------------------------------------------------
            {
              key: "resolve_effort",
              phase: "検証強度解決",
              type: "task",
              maxRetries: 1,
              onFail: { action: "abort" },
              task: {
                action: "orchestrate",
                buildPrompt: (ctx: PromptCtx) => {
                  return buildStepPrompt({
                    purpose: [
                      "Issue body の effort コメントから検証強度を解決する。人手選択は行わない。",
                    ],
                    criteria: [],
                    approach: [
                      "1. セッションディレクトリの issue-body.md（または artifacts の issue-body.md）を読み、末尾の `<!-- effort: width=... depth=... -->` を確認する",
                      "2. コメントがあればその width/depth を報告する。なければ width=medium depth=medium を適用する旨を報告する",
                      "3. プロンプト記法 `width=... depth=...` による上書きは無視する",
                      "4. effort.json の生成は行わない（生成は run_reviewers.beforeStep が担う）。check は純粋判定のみ",
                    ],
                    output: [],
                    input: [`セッションディレクトリ: ${ctx.sessionDir}`],
                  });
                },
              },
              check: (ctx: CheckCtx): CheckResult => {
                // effort.json が既にあれば mt-review-diff の SoT check に委譲（純粋検証のみ）
                const origCheck = resolveEffortStep.check;
                const existingRaw =
                  findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
                  readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
                if (existingRaw) {
                  return origCheck(ctx);
                }
                // effort.json がない場合、Issue body の HTML コメントのみで判定する
                const issueBody = (() => {
                  try {
                    const t = findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
                    if (t) return t;
                  } catch {}
                  return readSessionFile(ctx.sessionDir, "issue-body.md");
                })();
                if (hasInvalidEffortComment(issueBody)) {
                  return {
                    status: "fail",
                    reasons: [
                      "Issue body の effort コメントが不正です。mt-plan-create で修正して再実行してください（形式: <!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->）",
                    ],
                  };
                }
                const derived = ensureEffortFromIssueBody(ctx.sessionDir, ctx.artifacts);
                if (derived) {
                  if (!VALID_WIDTHS.has(derived.width) || !VALID_DEPTHS.has(derived.depth)) {
                    return {
                      status: "fail",
                      reasons: [
                        "Issue body の effort コメントが不正です。mt-plan-create で修正して再実行してください（形式: <!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->）",
                      ],
                    };
                  }
                  return {
                    status: "pass",
                    reasons: [
                      `effort derived from issue body: width=${derived.width} depth=${derived.depth}`,
                    ],
                  };
                }
                return {
                  status: "pass",
                  reasons: [
                    "effort not specified — will be generated with medium/medium in run_reviewers.beforeStep",
                  ],
                };
              },
            },

            // -------------------------------------------------------------------
            // Step 5: 検証者起動（mt-review-diff から import — 旧 review_work 置換）
            // -------------------------------------------------------------------
            {
              ...runReviewersStep,
              phase: "検証者起動",
              // ADR-0019: レビュー判断は Step import を維持。plan-run の収集専用
              // collect_context は撤去し、プロンプト生成前に収集・機械検証を完結する。
              beforeStep: collectPlanReviewContext,
            },

            // -------------------------------------------------------------------
            // Step 5: findings 正規化（mt-review-diff から import — difit に触らない純粋処理）
            // -------------------------------------------------------------------
            {
              ...normalizeFindingsStep,
              phase: "findings 正規化",
              beforeStep: async (ctx) => {
                const effortPath = join(ctx.sessionDir, REVIEW_EFFORT_KEY);
                const effort = JSON.parse(fs.readFileSync(effortPath, "utf-8"));
                effort.round = ctx.loop!.iteration;
                fs.writeFileSync(effortPath, `${JSON.stringify(effort, null, 2)}\n`, "utf-8");
                return [];
              },
            },

            // -------------------------------------------------------------------
            // Step 5.5: 自律判定（plan-run 所有 — must>0 なら自律 loop の continue で反復）
            //         反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
            //         apply_feedback へ巻き戻る（report の nextAction は repeat）。
            //         round は normalize_findings 前にエンジンの反復番号から設定する。
            // -------------------------------------------------------------------
            {
              key: "agent_verdict",
              phase: "自律判定",
              type: "task",
              maxRetries: 0,
              onFail: { action: "escalate" },
              task: {
                action: "orchestrate",
                buildPrompt: (ctx: PromptCtx) => {
                  return buildStepPrompt({
                    purpose: [
                      "normalize_findings が生成した findings.json の must 件数で自律/人相を振り分ける。人への受け渡しは行わない。",
                    ],
                    criteria: [],
                    approach: [
                      "1. セッションディレクトリの findings.json を読み、counts.must / counts.should と round を確認する",
                      `2. round < ${REVIEW_ROUND_LIMIT} で must>0 なら自律ループを継続し、apply_feedback へ戻る。`,
                      `3. round が上限 ${REVIEW_ROUND_LIMIT} に達したら、残 must / should / want を既存 difit 登録経路で提示し、追加確認なしで await_human_review へ渡す。`,
                      "4. must==0 の場合も difit 登録後に人間レビューへ進む。",
                    ],
                    output: [],
                    input: [`セッションディレクトリ: ${ctx.sessionDir}`],
                  });
                },
              },
              check: (ctx: CheckCtx): CheckResult => {
                const findingsRaw =
                  findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
                  readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY) ??
                  readSessionFile(ctx.sessionDir, "findings.json");
                const findingsResult = validateFindingsJson(findingsRaw);
                if (!findingsResult.valid || !findingsResult.parsed) {
                  return {
                    status: "error",
                    reasons: [findingsResult.error ?? "findings validation failed"],
                  };
                }
                const { must, should } = findingsResult.parsed.counts;
                const round = findingsResult.parsed.round;
                if (must > 0) {
                  if (round < REVIEW_ROUND_LIMIT) {
                    return {
                      status: "continue",
                      reasons: [
                        `must=${must} should=${should} — continue autonomous_review_cycle (${round}/${REVIEW_ROUND_LIMIT})`,
                      ],
                    };
                  }
                  return {
                    status: "pass",
                    reasons: [
                      `自律上限 ${round}/${REVIEW_ROUND_LIMIT}。残指摘を既存の start_difit_review で登録し await_human_review へ渡します`,
                    ],
                  };
                }
                return {
                  status: "pass",
                  reasons: [
                    `agent verdict passed: round=${round} must=0 -> proceed to human phase`,
                  ],
                };
              },
            },

            // -------------------------------------------------------------------
            // Step 5.6: difit レビュー起動（mt-review-diff から import — B相入口。
            //           start + コメント注入 + URL 提示を 1 ステップで行う）
            // -------------------------------------------------------------------
            {
              ...startDifitReviewStep,
              phase: "difit レビュー起動",
            },

            // Step 6: 人間レビュー待機は人間サイクル（外側 loop 本体）へ移動した。
            // 自律ループ完走後に人間がレビューし、judge_human が gateAnswers を読んで分岐する。

            // -------------------------------------------------------------------
            // verdict は非破壊で突合する。異常は tado の onFail に委ねる。
            {
              ...collectAutonomousVerdictStep,
              phase: "verdict 収集",
              maxRetries: 0,
              onFail: { action: "escalate" },
            },
          ], // autonomous_review_cycle body
        },

        // -------------------------------------------------------------------
        // 自律上限または must=0 で既存 difit セッションを人間に提示する。
        // 差し戻しは judge_human が外側 loop の continue に変換する。
        {
          ...awaitHumanReviewStep,
          phase: "人間レビュー待機",
          condition: isHumanReviewPhase,
          // mt-review-diff 単独では入力した修正理由の消費先が存在しない（確認と回答保存のみ）。
          // plan-run ではループ所有者として、入力した修正理由が gateAnswers
          // （await_human_review.decision の input）に記録され、apply_feedback が
          // feedback.json へ統合して execute_work の修正指示として参照することを案内する。
          humanGate: {
            ...awaitHumanReviewStep.humanGate!,
            questions: awaitHumanReviewStep.humanGate!.questions.map((question) => {
              if (question.key !== "decision") return question;
              return {
                ...question,
                description: `自律レビューは must=0 または上限 ${REVIEW_ROUND_LIMIT} 回で終了します。findings.json の round が ${REVIEW_ROUND_LIMIT} なら自律上限到達です。残 must / should / want は重要度を変えず difit に登録済みです。difit-start.json の URL を開き、修正結果を確認してください。承認には difit 上の未解決 must=0 が必須です。未修正受容や別Issue引き継ぎでは完了できません。差し戻すと自律レビュー最大 ${REVIEW_ROUND_LIMIT} 回の予算を再付与します。`,
                choices: question.choices?.map((choice) =>
                  choice.value === "request_changes"
                    ? {
                        ...choice,
                        desc: "judge_human が gateAnswers を読んで人間ループ先頭（自律ループ）へ巻き戻す。入力した修正理由は apply_feedback が feedback.json へ統合し、execute_work の修正指示として参照される",
                      }
                    : choice,
                ),
              };
            }),
          },
        },

        // -------------------------------------------------------------------
        // Step 9: 人間差し戻し判定（plan-run 所有・人間 loop 末尾）
        //         await_human_review の gateAnswers を読んで分岐する loop の check。
        //         request_changes → 判定 `continue` で人間 loop 先頭（= 自律ループ）へ
        //         巻き戻る（範囲内の自律ループの反復状態は初期化される）。
        //         round は人間 loop の反復に写像しないため前進させない。
        //         approve のときだけ最新 difit 検証・後始末へ進む。
        // -------------------------------------------------------------------
        {
          key: "judge_human",
          phase: "人間差し戻し判定",
          type: "task",
          maxRetries: 0,
          onFail: { action: "abort" },
          task: {
            action: "orchestrate",
            readonly: false,
            buildPrompt: (ctx: PromptCtx) =>
              buildStepPrompt({
                purpose: [
                  "await_human_review の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
                ],
                criteria: [],
                approach: [
                  "- 状態を変更しない（read-only）。ファイルの作成・編集、`mt difit` コマンドの実行をしない",
                  "- report のみ行う。check が承認時の最新未解決 must=0 を確認し、その後に difit を後始末する。差し戻し時はセッションを保持する。",
                ],
                output: [],
                input: [`セッションディレクトリ: ${ctx.sessionDir}`],
              }),
          },
          check: (ctx: CheckCtx): CheckResult => {
            // await_human_review の condition（isHumanReviewPhase と共有）は findings 不正時に
            // gate を提示せず false を返す。check は自律段階の異常を人間レビューにすり替えないよう
            // findings を再検証し、不正時は gateAnswers を読まず error を返す（分岐の分離）。
            const findingsRaw =
              findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
              readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
            const findingsResult = validateFindingsJson(findingsRaw);
            if (!findingsResult.valid || !findingsResult.parsed) {
              return {
                status: "error",
                reasons: [
                  `findings.json を検証できないため人間レビュー提示にしない（自律段階の異常を人間レビューにすり替えない）: ${findingsResult.error ?? "invalid findings"}`,
                ],
              };
            }
            // 人間レビュー前の状態を完了扱いにしない。
            if (!isHumanReviewPhase(ctx)) {
              return {
                status: "error",
                reasons: ["人間レビューへの引き渡し条件を満たしていません"],
              };
            }
            const decision = judgeGateRework(
              gateDecisionValue(ctx.gateAnswers, "await_human_review"),
              {
                gateKey: "await_human_review",
                loopKey: "human_review_cycle",
                headKey: "autonomous_review_cycle",
              },
            );
            return decision.status === "pass" ? completeHumanReviewStep.check(ctx) : decision;
          },
        },
      ], // human_review_cycle body
    },

    // -------------------------------------------------------------------
    // Step 8: 完了処理（in-progress → done）
    // -------------------------------------------------------------------
    {
      key: "finalize_done",
      phase: "完了処理",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: ["計画 Issue を `done` に遷移し、完了処理を行う。"],
            criteria: [],
            approach: [
              "1. Issue body を再読み込みし、完了条件がすべて満たされていることを最終確認する",
              "",
              "2. `transition-plan.ts` を使って `in-progress` → `done` に遷移する:",
              "",
              "```bash",
              `bun run ${join(import.meta.dir, "../_shared/mt-plan-transition-plan.ts")} <number> done`,
              "```",
              "",
              "このコマンドは以下を自動実行する:",
              "- GitHub Project の Status を `done` に更新",
              "- Issue を close",
              "- `## 🐢 履歴` へ遷移エントリを追記",
              "- 親計画が存在する場合は自動的に親の状態集約を行う（出力の `parent:` 行を確認）",
              "",
              "3. 完了を報告する:",
              "   - Issue の URL・番号",
              "   - 完了した作業",
              "   - 残っている未決事項（あれば）",
              "",
            ],
            output: [
              "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
              "```json",
              `{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}`,
              "```",
            ],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          });
        },
      },
      // 統一最低ライン+ 副作用実照合: done 遷移の実態（Issue が CLOSED）を gh で確認。
      check: (ctx: CheckCtx): CheckResult => {
        const result = requireStepArtifacts(ctx, [
          { key: "plan-number.txt", form: "text", pattern: /^[0-9]+$/ },
        ]);
        if (result.status !== "pass") return result;
        const raw = findArtifactText(ctx.artifacts, "plan-number.txt", ctx.sessionDir);
        const number = (raw ?? "").trim();
        const ghReasons = verifyIssueClosed(number);
        if (ghReasons.length > 0) return { status: "fail", reasons: ghReasons };
        const reasons = [`issue #${number} is closed on GitHub`];
        return { status: "pass", reasons };
      },
    },
  ],
};

export default def;
