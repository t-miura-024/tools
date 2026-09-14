import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ConditionCtx,
  ArtifactRecord,
} from "tado";
import { basename, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Database } from "bun:sqlite";
import { loadConfig } from "../_shared/mt-plan-init-config";
// NOTE(ADR-0019): Step import は StepDef のみに限定する方針を grill で合意済み。
// mt-review-diff が敵対的検証の単一 SoT であり、mt-plan-run は StepDef 定義のみを
// 直接 import して再利用する。純粋関数・定数 (findArtifactText 等) は
// _shared/mt-review-helpers.ts が SoT であり、Step 以外は _shared 経由で import する。
// resolve_effort の human_gate は廃止済みのため、effort 解決は Issue body コメント
// （mt-plan-create が書く `<!-- effort: ... -->`）または medium/medium のみで行う。
import {
  resolveEffortStep,
  collectContextStep,
  runReviewersStep,
  normalizeFindingsStep,
  startDifitReviewStep,
  awaitHumanReviewStep,
  collectVerdictStep,
} from "../mt-review-diff/index.ts";
import {
  findArtifactText,
  readSessionFile,
  validateFindingsJson,
  validateVerdictJson,
  parseDifitCheck,
  parseJson,
  isRecord,
  cleanupDifitSession,
  describeDifitSelectionDrift,
  requireDifitSelectionDrift,
  isRoundLimitReached,
  validateEffort,
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

/**
 * tado の task goto は失敗元だけを再キューするため、最後の
 * collect_verdict から execute_work に戻る際は、間にある review steps も
 * pending に戻しておく。これがないと、修正後に collect_verdict だけが再実行
 * され、execute_work → normalize_findings → difit のサイクルにならない。
 *
 * tado のセッション DB は共有の ~/.tado/workflow.db（TADO_HOME で上書き可）に
 * あり、セッションディレクトリには置かれない（countReviewRounds と同じ）。
 */
function resetReviewCycle(sessionDir: string): void {
  const dbPath = getWorkflowDbPath();
  if (!fs.existsSync(dbPath)) return;

  // PromptCtx/CheckCtx.sessionId は tado が値を設定しないため sessionDir の
  // basename（= セッション ID）から導出する（countReviewRounds と同じ）
  const sessionId = basename(sessionDir);
  const db = new Database(dbPath);
  try {
    const executeStep = db
      .query("SELECT step_index FROM steps WHERE session_id = ? AND step_key = 'execute_work'")
      .get(sessionId);
    if (!executeStep || typeof executeStep.step_index !== "number") return;
    db.run(
      "UPDATE steps SET status = 'pending', retry_count = 0 WHERE session_id = ? AND step_index > ?",
      sessionId,
      executeStep.step_index,
    );
  } finally {
    db.close();
  }
}

function getWorkflowDbPath(): string {
  const configuredHome = process.env.TADO_HOME?.trim();
  const home = configuredHome || os.homedir();
  return join(home, ".tado", "workflow.db");
}

/// execute_work が人間ゲートの revise 理由を保存するセッションファイル。
/// task（オーケストレーター）が workflow.db から抽出して書き、check が DB の
/// confirmed revise イベントと突合する。
const REVISE_FEEDBACK_KEY = "revise-feedback.json";

/// revise 理由を運ぶ人間ゲートの step_key。check の期待値導出と prompt のクエリが共有する。
const REVISE_GATE_STEP_KEYS = [
  "await_human_review",
  "round_stall_gate",
  "round_limit_gate",
] as const;

interface ReviseFeedbackItem {
  stepKey: string;
  reason: string;
}

type ConfirmedReviseRead =
  | { status: "ok"; items: ReviseFeedbackItem[] }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

/// answers_json（tado の gateAnswers。`{"decision":{"value":"revise","input":"..."}}`）から
/// revise の修正理由を抽出する（純粋関数）。decision 以外の設問キーでも value === "revise" を
/// 探す（outcomeQuestionKey の写経を避ける）。revise 以外の回答は not-revise。
function parseGateReviseOutcome(
  answersJson: string | null,
):
  | { status: "revise"; reason: string }
  | { status: "not-revise" }
  | { status: "invalid"; detail: string } {
  if (!answersJson) return { status: "invalid", detail: "answers_json が空です" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(answersJson);
  } catch (error) {
    return {
      status: "invalid",
      detail: `answers_json の JSON パースに失敗しました: ${String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { status: "invalid", detail: "answers_json が JSON オブジェクトではありません" };
  }
  for (const value of Object.values(parsed)) {
    if (!isRecord(value) || value.value !== "revise") continue;
    const input = value.input;
    if (typeof input !== "string" || input.trim() === "") {
      return { status: "invalid", detail: "revise の追加入力（修正理由）が空です" };
    }
    return { status: "revise", reason: input };
  }
  return { status: "not-revise" };
}

/// 本セッション（sessionDir の basename = session_id）の confirmed な revise ゲートイベントを
/// workflow.db から読み、期待される revise 理由一覧を返す。
///
/// workflow.db は ~/.tado 配下の全セッション共有 DB のため、必ず session_id と
/// event = 'confirmed' で絞る（別セッションの revise 入力の混入を機械的に防ぐ）。
/// DB を開けない・スキーマが読めない場合は「検証不能」として unavailable を返し、
/// 呼び出し元が warning として可視化する（fail-closed で止めるのは、revise イベントを
/// 確認できたのに理由を抽出できない場合 = error）。
function readConfirmedReviseFeedback(sessionDir: string): ConfirmedReviseRead {
  const dbPath = getWorkflowDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      status: "unavailable",
      reason: `workflow.db が見つからないため（${dbPath}）、人間ゲートの revise 理由を検証できません（TADO_HOME が実行中の tado と一致しているか確認してください）`,
    };
  }
  let db: Database | undefined;
  try {
    db = new Database(dbPath);
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_events'")
      .get();
    if (!table) {
      return {
        status: "unavailable",
        reason: `workflow.db（${dbPath}）に gate_events テーブルがないため、人間ゲートの revise 理由を検証できません`,
      };
    }
    const placeholders = REVISE_GATE_STEP_KEYS.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT step_key, answers_json FROM gate_events WHERE session_id = ? AND event = 'confirmed' AND step_key IN (${placeholders}) ORDER BY id`,
      )
      .all(basename(sessionDir), ...REVISE_GATE_STEP_KEYS) as {
      step_key: string;
      answers_json: string | null;
    }[];
    const items: ReviseFeedbackItem[] = [];
    for (const row of rows) {
      const outcome = parseGateReviseOutcome(row.answers_json);
      if (outcome.status === "not-revise") continue;
      if (outcome.status === "invalid") {
        return {
          status: "error",
          reason: `workflow.db の ${row.step_key}（session_id=${basename(sessionDir)}）に confirmed な revise イベントがありますが、修正理由を抽出できません: ${outcome.detail}`,
        };
      }
      items.push({ stepKey: row.step_key, reason: outcome.reason });
    }
    return { status: "ok", items };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `workflow.db（${dbPath}）から revise 理由を読めません: ${String(error)}`,
    };
  } finally {
    db?.close();
  }
}

/// execute_work の check が revise-feedback.json の内容を検証する。
///
/// 契約: `{ "sessionId": "<sessionDir basename>", "items": [{"stepKey": "...", "reason": "..."}] }`。
/// DB の confirmed revise イベント（stepKey + reason の multiset）と完全一致を要求し、
/// 欠落・余剰・他セッションの sessionId・空の reason は fail にする。初回など revise が
/// 無い実行ではファイル不要（存在する場合は items 空のみ許容）。DB を読めない場合は
/// 検証不能の warning を pass 理由に残す（無音にしない）。
function verifyReviseFeedback(sessionDir: string): {
  status: "pass" | "fail" | "error";
  reasons: string[];
} {
  const expected = readConfirmedReviseFeedback(sessionDir);
  if (expected.status === "error") {
    return { status: "error", reasons: [expected.reason] };
  }
  if (expected.status === "unavailable") {
    return {
      status: "pass",
      reasons: [`warning: ${expected.reason}（revise 理由の検証は未実施）`],
    };
  }

  const feedbackPath = join(sessionDir, REVISE_FEEDBACK_KEY);
  let raw: string | undefined;
  let readError: string | undefined;
  try {
    raw = fs.readFileSync(feedbackPath, "utf-8");
  } catch (error) {
    // ENOENT（未作成）と読み取り不能（EACCES / EISDIR 等）を区別し、後者は理由を明示する
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") {
      readError = String(error);
    }
  }
  if (raw === undefined) {
    if (expected.items.length === 0) {
      return {
        status: "pass",
        reasons: [`${REVISE_FEEDBACK_KEY} は未作成（本セッションの confirmed revise なし）`],
      };
    }
    if (readError !== undefined) {
      return {
        status: "fail",
        reasons: [
          `本セッションの confirmed な revise が ${expected.items.length} 件ありますが、${REVISE_FEEDBACK_KEY} を読み取れません: ${readError}`,
        ],
      };
    }
    return {
      status: "fail",
      reasons: [
        `本セッションの confirmed な revise が ${expected.items.length} 件ありますが、${REVISE_FEEDBACK_KEY} がありません。workflow.db の gate_events（session_id と event = 'confirmed' で絞る）から revise 理由を抽出し、契約 { "sessionId": "${basename(sessionDir)}", "items": [{"stepKey": "...", "reason": "<原文>"}] } で保存してください`,
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "fail",
      reasons: [`${REVISE_FEEDBACK_KEY} を JSON として読めません: ${String(error)}`],
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: "fail",
      reasons: [`${REVISE_FEEDBACK_KEY} が JSON オブジェクトではありません`],
    };
  }
  const sessionId = basename(sessionDir);
  if (parsed.sessionId !== sessionId) {
    return {
      status: "fail",
      reasons: [
        `${REVISE_FEEDBACK_KEY} の sessionId=${String(parsed.sessionId)} が本セッション ${sessionId} と一致しません（別セッションの revise 理由が混入しています）`,
      ],
    };
  }
  if (!Array.isArray(parsed.items)) {
    return { status: "fail", reasons: [`${REVISE_FEEDBACK_KEY} の items が配列ではありません`] };
  }
  const actual: ReviseFeedbackItem[] = [];
  for (const [index, item] of parsed.items.entries()) {
    if (!isRecord(item)) {
      return {
        status: "fail",
        reasons: [`${REVISE_FEEDBACK_KEY}.items[${index}] がオブジェクトではありません`],
      };
    }
    const stepKey = item.stepKey;
    if (typeof stepKey !== "string" || !REVISE_GATE_STEP_KEYS.some((key) => key === stepKey)) {
      return {
        status: "fail",
        reasons: [
          `${REVISE_FEEDBACK_KEY}.items[${index}].stepKey が不正です: ${String(stepKey)}（${REVISE_GATE_STEP_KEYS.join(" / ")} のいずれか）`,
        ],
      };
    }
    const reason = item.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      return {
        status: "fail",
        reasons: [`${REVISE_FEEDBACK_KEY}.items[${index}].reason が空または文字列ではありません`],
      };
    }
    actual.push({ stepKey, reason });
  }

  if (expected.items.length === 0 && actual.length > 0) {
    return {
      status: "fail",
      reasons: [
        `workflow.db に本セッション（${sessionId}）の confirmed revise が無いのに ${REVISE_FEEDBACK_KEY} に ${actual.length} 件の items があります。別セッションの revise 理由を本セッションの修正指示として使わないでください`,
      ],
    };
  }
  const countKey = (items: ReviseFeedbackItem[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = `${item.stepKey}\u0000${item.reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const expectedCounts = countKey(expected.items);
  const actualCounts = countKey(actual);
  const describe = (item: ReviseFeedbackItem): string =>
    `${item.stepKey}: ${item.reason.slice(0, 80)}`;
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const [key, count] of expectedCounts) {
    const diff = count - (actualCounts.get(key) ?? 0);
    for (let i = 0; i < diff; i += 1) {
      const item = expected.items.find((entry) => `${entry.stepKey}\u0000${entry.reason}` === key)!;
      missing.push(describe(item));
    }
  }
  for (const [key, count] of actualCounts) {
    const diff = count - (expectedCounts.get(key) ?? 0);
    for (let i = 0; i < diff; i += 1) {
      const item = actual.find((entry) => `${entry.stepKey}\u0000${entry.reason}` === key)!;
      unexpected.push(describe(item));
    }
  }
  if (missing.length > 0 || unexpected.length > 0) {
    return {
      status: "fail",
      reasons: [
        `${REVISE_FEEDBACK_KEY} が workflow.db の confirmed revise と一致しません（欠落 ${missing.length} 件: ${missing.join(" / ") || "なし"}、余剰 ${unexpected.length} 件: ${unexpected.join(" / ") || "なし"}）。reason は input 原文のまま保存してください`,
      ],
    };
  }
  return {
    status: "pass",
    reasons: [
      expected.items.length === 0
        ? `${REVISE_FEEDBACK_KEY} を検証しました（本セッションの confirmed revise なし）`
        : `${REVISE_FEEDBACK_KEY} を検証しました（本セッションの confirmed revise ${expected.items.length} 件: ${expected.items.map((item) => item.stepKey).join(", ")}）`,
    ],
  };
}

/// verdict.json の round と findings.json の round の大きい方を「実効ラウンド」として扱う。
/// collect_verdict / サブエージェントが verdict に古い round を書いても、findings.json は
/// effort.json の前進（advanceReviewRound）を継承するため、上限判定は実効ラウンドで行い、
/// verdict.round の不追従による終端不能（round_limit_gate へ到達しない反復）を防ぐ。
function effectiveReviewRound(verdict: VerdictJson, findings: FindingsJson | undefined): number {
  return findings ? Math.max(verdict.round, findings.round) : verdict.round;
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

/// round_limit_gate / release_difit_session の condition。
///
/// 1. verdict が解決できる場合: 実効ラウンド（verdict / findings の大きい方）が上限到達か。
/// 2. verdict を解決できない場合: collect_verdict の error が連続し、effort.json の round
///    だけがループカウンタとして前進している経路。effort.json の round が上限に達して
///    いれば true とし、condition が attemptResult を持たなくても人間ゲートへ到達できる
///    ようにする（error が決定論的に再発しても execute_work を無制限に反復しない）。
function roundLimitReached(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): boolean {
  const verdict = resolveReviewVerdict(ctx);
  if (verdict) {
    const findings = resolveReviewFindings(ctx);
    return isRoundLimitReached({
      ...verdict,
      round: effectiveReviewRound(verdict, findings),
    });
  }
  const effortRaw =
    findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
  const effort = validateEffort(parseJson(effortRaw), { allowRoundOverflow: true });
  return effort.status === "pass" && effort.round >= REVIEW_ROUND_LIMIT;
}

/// 実効ラウンドが上限に達した「通過済み」レビューか（round_limit_passed_gate の condition）。
/// human_gate の文言は静的なため、passed による文言分岐は condition で提示ゲートを
/// 分離して行う（通過済みは「上限到達・通過済み。後始末へ」、未通過は従来の文言）。
function roundLimitPassed(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): boolean {
  const verdict = resolveReviewVerdict(ctx);
  if (!verdict) return false;
  const round = effectiveReviewRound(verdict, resolveReviewFindings(ctx));
  return verdict.passed && round > REVIEW_ROUND_LIMIT;
}

/// 実効ラウンドが上限に達した「未通過」レビューか（round_limit_gate の condition）。
/// verdict を解決できない連続 error のエスカレーションもこちらへ倒す。
function roundLimitUnpassed(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): boolean {
  return roundLimitReached(ctx) && !roundLimitPassed(ctx);
}

/// collect_verdict の check（origCheck）と同じ解決チェーンで verdict を解決する。
/// artifact（report 申告）→ セッションファイル → report の subagentOutput の順。
/// ファイル経路しか見ないと、orchestrator が verdict を subagentOutput にだけ載せた
/// 場合に round limit の検出（origCheck は fail）と復旧判定（roundLimitReached は false）
/// が食い違い、上限到達済みでも execute_work へ差し戻される。
function resolveReviewVerdictRaw(ctx: CheckCtx): string | undefined {
  return (
    findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY) ??
    ctx.attemptResult.subagentOutput
  );
}

/// findings の round が前回 verdict から前進していない（= レビュー済みラウンドへの
/// 再入で round 前進の写像が欠落している）状態か。agent_verdict の停滞検出と
/// round_stall_gate の condition が同じ写像を使う（写像ドリフト防止）。
function roundStalled(findings: FindingsJson, verdict: VerdictJson | undefined): boolean {
  if (findings.counts.must <= 0) return false;
  if (!verdict) return false;
  return findings.round <= verdict.round;
}

/// round_stall_gate の condition。findings / verdict をファイル経路から読み、
/// roundStalled を評価する（condition は attemptResult を持たない）。
function roundStallDetected(ctx: { sessionDir: string; artifacts: ArtifactRecord[] }): boolean {
  const findingsRaw =
    findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
  const findings = validateFindingsJson(findingsRaw);
  if (!findings.valid || !findings.parsed) return false;
  const verdictRaw =
    findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY);
  const verdict = validateVerdictJson(verdictRaw);
  return roundStalled(findings.parsed, verdict.valid ? verdict.parsed : undefined);
}

/// 次ラウンドのレビュー番号（effort.json の round）を決定論的に 1 進める。
///
/// normalize_findings は effort.json の round を findings.json へ継承し、collect_verdict は
/// findings.json の round を verdict.json へ継承する。execute_work へのループバック時に
/// ここで effort.json の round を進めないと round が 1 のまま固定され、round_limit_gate
/// （round 上限の人間判断）へ到達しない。呼び出し元（agent_verdict / collect_verdict）は
/// この失敗を error として報告し、無音の no-op を作らない（round が進まないまま
/// 高コストな SubAgent 実行を反復する無限ループを防ぐ）。
///
/// 書き込みは一時ファイル + rename でアトミック化し、truncate→write 中の
/// プロセス終了や並行実行で effort.json が破損する窓を作らない。
/// 更新後は読み直して round が実際に進んだことまで検証する。
function advanceReviewRound(sessionDir: string): number {
  const effortPath = join(sessionDir, "effort.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(effortPath, "utf-8"));
  } catch (error) {
    throw new Error(`effort.json を読めません (${effortPath}): ${String(error)}`);
  }
  // round の契約検証は validateEffort（SoT）に委譲する。round=0 / 小数 / 欠落は
  // ここでも throw し、サイトごとに合否が割れる手書き検証を置かない。
  const validation = validateEffort(parsed, { allowRoundOverflow: true });
  if (validation.status !== "pass") {
    throw new Error(
      `effort.json の契約が不正です (${effortPath}): ${validation.reasons.join(" / ")}`,
    );
  }
  const effort = parsed as Record<string, unknown>;
  const round = validation.round;

  effort.round = round + 1;
  const tmpPath = `${effortPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(effort, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, effortPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw new Error(`effort.json の round 更新に失敗しました (${effortPath}): ${String(error)}`);
  }

  // rename 後も round が進んだことを読み直して検証する（無音の no-op を作らない）。
  const updated = JSON.parse(fs.readFileSync(effortPath, "utf-8")) as Record<string, unknown>;
  if (updated.round !== round + 1) {
    throw new Error(
      `effort.json の round 更新を検証できませんでした (expected ${round + 1}, got ${String(updated.round)})`,
    );
  }
  return round + 1;
}

/// execute_work 再入時に、レビュー済みラウンドの round を次ラウンドへ 1 進める。
///
/// round_limit_gate の「もう1巡続ける（revise）」は execute_work から再入するが、
/// この経路は collect_verdict / agent_verdict のループバックと違い round 前進の主体が
/// 存在しない（gate の revise はステップを pending に戻すだけで、round は誰も進めない）。
/// effort.json の round が直前 verdict の round 以下（= レビュー済みラウンドへの再入）なら
/// +1 して、normalize_findings → findings.json → verdict.json へ次ラウンドとして継承させる。
/// 通常のループバックでは前段（agent_verdict / collect_verdict）が前進済みで
/// effort.round > verdict.round のため no-op になる。
///
/// effort.json 不在（初回。生成は collect_context の責務）・不正、verdict 不在
/// （初回レビュー前）は前進の対象外として false を返す。前進が必要な場合の失敗は
/// advanceReviewRound が throw し、呼び出し元（execute_work の check）が error にする。
function advanceReviewRoundOnReentry(sessionDir: string): boolean {
  let effort: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(join(sessionDir, REVIEW_EFFORT_KEY), "utf-8"),
    );
    if (isRecord(parsed)) effort = parsed;
  } catch {
    effort = undefined;
  }
  if (!effort) return false;

  const verdictResult = validateVerdictJson(readSessionFile(sessionDir, REVIEW_VERDICT_KEY));
  if (!verdictResult.valid || !verdictResult.parsed) return false;

  // round の契約検証は validateEffort（SoT）に委譲する。契約違反（round 欠落/0/小数）は
  // 前進の対象外として false を返し、検出は resolve_effort / collect_context の check に委ねる。
  const validation = validateEffort(effort, { allowRoundOverflow: true });
  if (validation.status !== "pass") return false;
  if (validation.round > verdictResult.parsed.round) return false;

  advanceReviewRound(sessionDir);
  return true;
}

// plan-run 用: Issue body から effort を解析するヘルパ
// SoT は mt-plan-create の finalize が書く末尾 HTML コメントのみ:
// `<!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->`
// プロンプト記法 (width=... のばら撒き) や `width: ...` セクション記法は受理しない。
function parseEffortFromIssueBody(body: string | undefined): {
  width?: string;
  depth?: string;
} {
  if (!body) return {};
  const blocks = [...body.matchAll(/<!--\s*effort:.*?-->/gis)].map((m) => m[0]);
  if (blocks.length === 0) return {};
  const last = blocks[blocks.length - 1];
  const widthMatch = last.match(/width\s*=\s*(low|medium|high|xhigh|max)/i);
  const depthMatch = last.match(/depth\s*=\s*(max|xhigh|high|medium|low)/i);
  const result: { width?: string; depth?: string } = {};
  if (widthMatch) result.width = widthMatch[1].toLowerCase();
  if (depthMatch) result.depth = depthMatch[1].toLowerCase();
  return result;
}

/// Issue body に effort コメントらしきものがあるが、厳密な width+depth を
/// 満たさない場合に true。欠落（コメントなし）と区別し、不正時は medium 化せず止める。
function hasInvalidEffortComment(body: string | undefined): boolean {
  if (!body) return false;
  const blocks = [...body.matchAll(/<!--\s*effort:.*?-->/gis)].map((m) => m[0]);
  if (blocks.length === 0) return false;
  const parsed = parseEffortFromIssueBody(body);
  return !parsed.width || !parsed.depth;
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
    // check は純粋判定が契約のためファイル生成は行わない (生成は collect_context の task 側で実施)
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
        questions: [
          {
            key: "decision",
            title: "判定",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "計画を特定した",
                desc: "Issue番号を確認し次へ進む",
                input: { required: false, maxLength: 500 },
              },
              {
                value: "revise",
                label: "修正する",
                desc: "計画の特定をやり直す",
                input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
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
          return [
            "## 目的",
            "",
            "計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。",
            "",
            "## 手順",
            "",
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
            "7. 読み込んだ内容の要点を報告する:",
            "   - 完了条件の数と概要",
            "   - 主要な方針",
            "   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）",
            "",
            "8. 計画番号と Issue body を保存する。計画番号はセッションディレクトリの `plan-number.txt` に書き出し、report 時の `artifacts` に以下を含めること（申告漏れは check で fail になる）:",
            "```json",
            `[{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}, {"key": "issue-body.md", "path": "${ctx.sessionDir}/issue-body.md"}]`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
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
          return [
            "## 目的",
            "",
            "計画 Issue の `## 📄 ドキュメント` セクションをリポジトリの実ファイルへ転記する。",
            "",
            "## 手順",
            "",
            "### 1. ドキュメントセクションの抽出",
            "",
            `セッションディレクトリの issue-body.md から \`## 📄 ドキュメント\` セクションを抽出する。`,
            "",
            "### 2. 各ブロックの書き出し",
            "",
            "各 `### <リポジトリ相対パス>` 見出しと直下のコードフェンス（ファイル全文）を、指定パスへ書き出す。",
            "",
            "- ADR 連番が既存ファイルと衝突する場合は、次の空き番号へリネームして書き出す",
            "- 既存ファイル（主に `CONTEXT.md`）がある場合は既存内容を読み、計画側の内容を正としてマージする（`_Avoid_` ルールに従う）",
            "- 書き出しは未コミット差分として残す（コミットは行わない）",
            "",
            "### 3. 書き出し結果の報告",
            "",
            "書き出したファイル一覧（パス・新規/更新・マージの有無）を報告する。",
            "",
            "## 成果物",
            "",
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
            "",
            // セッション情報はエンジンが自動付与する（ADR-0003）
          ].join("\n");
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
          // 本セッションの session_id はセッションディレクトリの basename（tado は
          // PromptCtx.sessionId を設定しない。resetReviewCycle / countReviewRounds と同じ導出）。
          const sessionId = basename(ctx.sessionDir);
          return [
            "## 目的",
            "",
            "計画 Issue の `## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針` に従って作業を実行する。",
            "作業の実施は必ず `mt-plan-work-executor` SubAgent に委譲する。オーケストレーター自身はリポジトリのファイル編集を行わず、ミッションの割り振り・進行管理・Issue body 更新に専念する。",
            "",
            "## 修正ソース（再実行時に適用）",
            "",
            "execute_work に戻ってきた場合、以下のソースから修正指示を統合して executor SubAgent に渡す:",
            "",
            "1. **findings.json の must 指摘**（run_reviewers の SubAgent レビューで検出された必須修正）",
            "2. **findings.json の should 指摘**（difit 上で `🙋 question` として提示されたもの）",
            "3. **findings.json の want 指摘のうち人間 reply が付いたもの**（difit 上で人間が reply した want のみ。`mt difit check` の blocking_threads に blocking として現れる）",
            "4. **difit の blocking_threads**（`difit-check.json` / `verdict.json` の blocking_threads。未 resolve スレッドを人間 reply 込みで含む）",
            "5. **人間ゲートの revise で入力された修正理由**（await_human_review / round_stall_gate / round_limit_gate の「修正する」「もう1巡続ける（revise）」の input。tado の gateAnswers として workflow.db の `gate_events.answers_json` / `step_attempts.result_json` に記録される）",
            "",
            "各ソースの存在確認:",
            "- セッションディレクトリの `findings.json` を読み、must / should / want の全指摘を抽出する",
            "- セッションディレクトリの `verdict.json` と `difit-check.json` を読み、`blocking_threads[].body` と `replies`（人間 reply）を抽出する（`verdict.json` が SoT）",
            `- 人間ゲートの revise 理由は、TADO_HOME（既定 \`~/.tado\`）配下の \`workflow.db\` から **本セッション（session_id = \`${sessionId}\`）の confirmed なイベントだけ**を読んで抽出する。workflow.db は全セッション共有のため、session_id と event = 'confirmed' で必ず絞る（絞らないと別 Issue の revise 入力が本セッションの修正指示として混入する）。例: \`sqlite3 ~/.tado/workflow.db "select step_key, answers_json from gate_events where session_id = '${sessionId}' and event = 'confirmed' and step_key in ('await_human_review','round_stall_gate','round_limit_gate') order by id desc"\``,
            `- \`step_attempts.result_json\` 経由で読む場合も、必ず \`steps.session_id\` で本セッションに絞る。例: \`sqlite3 ~/.tado/workflow.db "select s.step_key, a.result_json from step_attempts a join steps s on s.id = a.step_id where s.session_id = '${sessionId}' and s.step_key in ('await_human_review','round_stall_gate','round_limit_gate') order by a.id desc"\``,
            `- 抽出結果はセッションディレクトリの \`${REVISE_FEEDBACK_KEY}\` に保存する。契約: \`{"sessionId": "${sessionId}", "items": [{"stepKey": "<gate step_key>", "reason": "<input 原文>"}]}\`。items は本セッションの confirmed revise 全件（reason は要約・改変せず input 原文のまま）。revise が無い実行ではファイルを作らないか items: [] とする`,
            "- revise 理由がある場合は、オーケストレーター自身の判断で握り潰さず executor への修正指示に原文のまま含める。check が workflow.db の confirmed revise と revise-feedback.json を突合し、欠落・余剰・別セッションの混入（sessionId 不一致）・空 reason は fail になる",
            "- 存在しないファイルは無視する（初回実行時は修正ソースなし）",
            "",
            "want 指摘の修正対象判定:",
            "- difit では want はノンブロッキングのため、人間 reply が付いた want スレッドだけが `mt difit check` の blocking_threads に blocking として現れる（返されたスレッドは修正対象）",
            "- blocking_threads に現れない want（人間 reply なし）は修正対象にしない",
            "",
            "修正指示の仕分け:",
            "- 指摘を該当ミッションのスコープで仕分けし、担当の executor SubAgent に修正指示として渡す",
            "- must / should はすべて対応対象。want は人間 reply が付いたもの（blocking_threads に現れたもの）のみ対応対象",
            "- difit の人間コメント・人間 reply はテキスト原文として executor に渡し、要約・省略・taxonomy の変更をしない",
            "",
            "対応完了時のスレッド resolve:",
            "- executor は対応した AI 指摘のスレッドを `mt difit resolve <threadId>` で resolve する（state の読み取り → 記録 pid が記録 port を LISTEN していることの照合 → 選択固定セッションへの resolve までを 1 コマンドで行い、人間コメントのスレッドは拒否される。`.difit/difit-review.json` の port を直接読んで `difit` CLI を叩かない）",
            "- must / should（taxonomy issue / question）: 対応したスレッドを resolve する",
            "- 人間 reply が付いた want: 対応後にスレッド（AI want + 人間 reply）を resolve する",
            "- 人間コメント（`taxonomy` == `human`）: resolve しない。修正が必要な場合も resolve は人間に委ね、未 resolve のまま残す",
            "- 人間 reply が付いていない want: 修正対象外のため resolve しない",
            "",
            ...(difitFeedback ? [difitFeedback, ""] : []),
            "## 手順",
            "",
            "### 1. ミッションの読み取り",
            "",
            "Issue body（`gh issue view <number> --json body`）から `## 🧩 ミッション` セクションを読み取る:",
            "",
            "- セクションがある場合: `### 実行順` の Wave 定義と各 `### M<n>: <名前>` ミッションのスコープ・完了条件を把握する",
            "- セクションがない場合: 計画全体を 1 ミッション（`M1: 全体`、スコープは計画のアウトプット範囲、完了条件は全番号）として扱う",
            "",
            "### 2. executor SubAgent の起動",
            "",
            'Wave 方式に従って、Task ツールで `subagent_type = "mt-plan-work-executor"` を起動する:',
            "",
            "- 同じ Wave 内のミッションは並列起動する（最大 5 同時）。同一メッセージで複数の Task ツール呼び出しを行う",
            "- 異なる Wave は番号順に直列実行する（Wave 2 は Wave 1 の全ミッション完了後に開始）",
            "- 各 SubAgent に渡す情報:",
            "  - 計画 Issue body 全文（完了条件・方針・アウトプットの判断に必要）",
            "  - 担当ミッション定義（ID・名前・スコープ・完了条件番号・Wave 所属）",
            "  - 修正指示（再実行時のみ: findings.json、verdict.json/difit-check.json の blocking_threads / 人間 reply の該当指摘）",
            "",
            "### executor の完了報告契約",
            "",
            "各 executor は、作業結果を次の構造化 JSON オブジェクトとして必ず返す:",
            "```json",
            "{",
            '  "changedFiles": ["<repository-relative-path>"],',
            '  "checks": [{"command": "<command>", "result": "<result>"}],',
            '  "unresolvedIssues": []',
            "}",
            "```",
            "",
            "### 3. 完了報告の集約",
            "",
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
            "## Issue body 更新（オーケストレーターが実施）",
            "",
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
            "",
            // セッション情報はエンジンが自動付与する（ADR-0003）
            "",
            "## 禁止事項",
            "",
            "- オーケストレーター自身がリポジトリのファイルを編集しない（作業は必ず executor SubAgent へ委譲）",
            "- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する",
            "- ユーザー承認前に `done` 化しない",
            "- 全ミッションの完了前に次のステップへ進まない",
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (ctx.attemptResult.status !== "completed") {
          return { status: "error", reasons: [ctx.attemptResult.errors ?? "execute_work failed"] };
        }
        // 統一最低ライン: executor 返却 JSON の集約物を成果物として強制。
        // 内容の妥当性検証は下流の reviewer/verdict（daemon 突合）に委譲する
        const base = requireStepArtifacts(ctx, [
          {
            key: "execution-result.json",
            form: "json",
            keys: ["changedFiles", "checks", "unresolvedIssues"],
          },
        ]);
        if (base.status !== "pass") return base;
        // 人間ゲートの revise 理由（revise-feedback.json）が workflow.db の confirmed
        // revise と一致することを検証する。抽出失敗・別セッション混入・欠落を無音にしない
        // （DB を読めない場合は warning を理由に残す）。
        const reviseFeedback = verifyReviseFeedback(ctx.sessionDir);
        if (reviseFeedback.status !== "pass") {
          return { status: reviseFeedback.status, reasons: reviseFeedback.reasons };
        }
        // round_limit_gate の「もう1巡続ける（revise）」再入は collect_verdict を経由しない
        // ため、ここでレビュー済みラウンドの round を次ラウンドへ進める（検出条件の詳細は
        // advanceReviewRoundOnReentry 参照。通常のループバックでは前段が前進済みで no-op）。
        try {
          if (advanceReviewRoundOnReentry(ctx.sessionDir)) {
            return {
              status: "pass",
              reasons: [
                ...base.reasons,
                ...reviseFeedback.reasons,
                "レビュー済みラウンドへの再入を検出し、round を次ラウンドへ前進させました",
              ],
            };
          }
        } catch (error) {
          return {
            status: "error",
            reasons: [`failed to advance review round on reentry: ${String(error)}`],
          };
        }
        return { status: "pass", reasons: [...base.reasons, ...reviseFeedback.reasons] };
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
          return [
            "## 目的",
            "",
            "Issue body の effort コメントから検証強度を解決する。人手選択は行わない。",
            "",
            "## 手順",
            "",
            "1. セッションディレクトリの issue-body.md（または artifacts の issue-body.md）を読み、末尾の `<!-- effort: width=... depth=... -->` を確認する",
            "2. コメントがあればその width/depth を報告する。なければ width=medium depth=medium を適用する旨を報告する",
            "3. プロンプト記法 `width=... depth=...` による上書きは無視する",
            "4. effort.json の生成は行わない（生成は collect_context が担う）。check は純粋判定のみ",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        // effort.json が既にあれば mt-review-diff の SoT check に委譲（純粋検証のみ）
        const origCheck = resolveEffortStep.check as (ctx: CheckCtx) => CheckResult;
        const existingRaw =
          findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
        if (existingRaw) {
          const result = origCheck(ctx);
          if (result.status !== "fail") return result;
          // round_limit_gate の「もう1巡続ける（revise）」再入では、execute_work の check が
          // round を +1 した後（round > REVIEW_ROUND_LIMIT）に resolve_effort が再実行される。
          // mt-review-diff の check は上限超過を fail で返すが、plan-run の resolve_effort は
          // onFail: abort のため、そのまま返すと人間ゲート（collect_verdict → round_limit_gate）
          // へ到達できずセッションが終了する。round の超過のみを人間が選んだ継続再入として
          // 許容し、上限の再判定は collect_verdict → round_limit_gate に委ねる。
          // width/depth/base/target の契約は mt-review-diff と共有の純粋関数 validateEffort で
          // 判定する（手書きの再実装を置かず、差は allowRoundOverflow だけにする）。
          const validation = validateEffort(parseJson(existingRaw), { allowRoundOverflow: true });
          if (validation.status === "pass" && validation.overflow) {
            return {
              status: "pass",
              reasons: [
                `round limit continuation: round=${validation.round} > ${REVIEW_ROUND_LIMIT}。execute_work 再入時に前進した round を継続し、上限の再判定は collect_verdict → round_limit_gate が行います`,
              ],
            };
          }
          return result;
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
            "effort not specified — will be generated with medium/medium in collect_context",
          ],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 4.5: 差分収集（mt-review-diff から import — plan-run では target なし = merge-base..ワーキングツリー（committed + staged + unstaged）+ untracked を収集）
    //           追加で Issue body 由来の effort.json 生成を担う（check は純粋判定のため）
    //           width/depth は Issue body コメントのみ、なければ medium/medium。base/target は既定動作を維持。
    // -------------------------------------------------------------------
    {
      ...collectContextStep,
      phase: "差分収集",
      task: {
        ...collectContextStep.task,
        buildPrompt: (ctx: PromptCtx) => {
          const basePrompt = (
            collectContextStep.task as unknown as { buildPrompt: (ctx: PromptCtx) => string }
          ).buildPrompt(ctx);
          const extra = [
            "",
            "## 追加手順（plan-run 固有: Issue body 由来の effort 補完）",
            "",
            "collect_context の agent は、effort.json が存在しない場合に以下で補完する（プロンプト記法 width=… depth=… による上書きは無視する）:",
            "1. セッションディレクトリの issue-body.md（または artifacts の issue-body.md）末尾の `<!-- effort: width=... depth=... -->` を解析し、width/depth を抽出できた場合はその値で effort.json を生成する",
            "2. 上記コメントがない場合は width=medium depth=medium で effort.json を生成する",
            "3. コメントがあるが形式不正（片方欠落・enum 外）の場合は生成せず error で停止し、mt-plan-create での修正を案内する",
            "4. base は未指定時に origin/HEAD 検出→失敗時 main、target は空の既定動作を維持する",
            "5. 生成時は `{ width, depth, round: 1 }` を effort.json として保存し、artifacts へ登録する",
            "なお check 段階ではファイル生成を行わず、ここで初めて生成する（check は純粋検証のみ）。",
          ].join("\n");
          return basePrompt + extra;
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        const base = collectContextStep.check(ctx);
        if (base.status !== "pass") return base;
        // effort.json（width/depth/round を含む）の契約を機械検証する。round が無い/不正の
        // まま agent_verdict のループバックへ進むと、round を前進できず round limit の
        // 人間ゲートへ到達しない無限ループになる。round の契約（1 以上の整数・必須）は
        // validateEffort（SoT）に一本化し、resolve_effort / normalize と同じ判定にする。
        const effortRaw =
          findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
        const effort = parseJson(effortRaw ?? "");
        if (!isRecord(effort)) {
          return {
            status: "fail",
            reasons: [
              `${REVIEW_EFFORT_KEY} が生成されていないか JSON オブジェクトではありません。width/depth/round を持つ effort.json を生成してください`,
            ],
          };
        }
        // collect_context はループバック（round > LIMIT の継続再入）でも実行されるため、
        // round の上限超過は許容して契約違反（欠落・0・小数）だけを fail にする。
        const validation = validateEffort(effort, { allowRoundOverflow: true });
        if (validation.status !== "pass") {
          return {
            status: "fail",
            reasons: [`${REVIEW_EFFORT_KEY} の契約が不正です: ${validation.reasons.join(" / ")}`],
          };
        }
        return {
          status: "pass",
          reasons: [...base.reasons, `effort.json: round=${validation.round}`],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 5: 検証者起動（mt-review-diff から import — 旧 review_work 置換）
    // -------------------------------------------------------------------
    {
      ...runReviewersStep,
      phase: "検証者起動",
    },

    // -------------------------------------------------------------------
    // Step 5: findings 正規化（mt-review-diff から import — difit に触らない純粋処理）
    // -------------------------------------------------------------------
    {
      ...normalizeFindingsStep,
      phase: "findings 正規化",
    },

    // -------------------------------------------------------------------
    // Step 5.5: 自律判定（plan-run 所有 — must>0 なら execute_work へ反復）
    // -------------------------------------------------------------------
    {
      key: "agent_verdict",
      phase: "自律判定",
      type: "task",
      maxRetries: 0,
      onFail: { action: "goto", target: "execute_work", requeueSource: true },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "normalize_findings が生成した findings.json の must 件数で自律/人相を振り分ける。人への受け渡しは行わない。",
            "",
            "## 手順",
            "",
            "1. セッションディレクトリの findings.json を読み、counts.must / counts.should と round を確認する",
            "2. round が上限（3）未満で must>0 の場合は修正が必要な旨を報告する（check が execute_work への反復を判定する）",
            "3. round が上限（3）に達して must>0 の場合は、round を進めず collect_verdict の round limit 判定から round_limit_gate（人間判断）へエスカレーションする旨を報告する",
            "4. round が前回 verdict から進んでいない場合は、round_stall_gate（人間判断）へエスカレーションする旨を報告する",
            "5. must==0 の場合は人相へ進める旨を報告する",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
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
          if (round >= REVIEW_ROUND_LIMIT) {
            // 自動ループ上限。ここで fail → goto execute_work を返すと round が進まないまま
            // 永久に反復し、round_limit_gate（人間判断）へ到達できない。また round を
            // LIMIT+1 に前進させると、再入した resolve_effort の上限判定でセッションが
            // abort し、エスカレーション経路へ到達しない。round を進めず pass で後段へ進め、
            // collect_verdict の round limit 判定から round_limit_gate へエスカレーションする
            // （await_human_review は must>0 のため skip される）。
            return {
              status: "pass",
              reasons: [
                `autonomous round limit reached: round=${round} >= ${REVIEW_ROUND_LIMIT} (must=${must}). execute_work へは戻さず、collect_verdict の round limit 判定で round_limit_gate へエスカレーションします`,
              ],
            };
          }

          // 前回の verdict より findings の round が実際に進んだことを検証する。
          // effort.json の round 前進（advanceReviewRound）が反映されていない
          // （= レビュー済みラウンドへの再入）場合、ここで error を返して goto execute_work
          // すると同条件で決定論的に再発し、人間の介入まで execute_work を反復する。
          // round の前進主体（execute_work の check）が働かない異常として、
          // round_stall_gate（human gate）へエスカレーションする。
          const previousVerdictRaw =
            findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY, ctx.sessionDir) ??
            readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY);
          const previousVerdict = validateVerdictJson(previousVerdictRaw);
          if (roundStalled(findingsResult.parsed, previousVerdict.parsed)) {
            return {
              status: "pass",
              reasons: [
                `round が前回 verdict から進んでいません (findings round=${round} <= verdict round=${previousVerdict.parsed!.round})。execute_work へは戻さず、round_stall_gate で人間が round 前進の欠落を判断します`,
                "effort.json の round を確認・修正するか、ゲートで execute_work からの再実行（再入時に round を前進）を選択してください",
              ],
            };
          }

          try {
            resetReviewCycle(ctx.sessionDir);
            // ループバック = 次ラウンド。round を進めて findings.json に継承させる。
            advanceReviewRound(ctx.sessionDir);
          } catch (error) {
            return {
              status: "error",
              reasons: [
                `failed to prepare next review round: ${String(error)}。round を前進できないため自律ループは round limit へ到達できません。effort.json を確認・修正するか、セッションを中断してください`,
              ],
            };
          }
          return {
            status: "fail",
            reasons: [`agent verdict blocked: must=${must} should=${should} -> goto execute_work`],
          };
        }
        return {
          status: "pass",
          reasons: [`agent verdict passed: round=${round} must=0 -> proceed to human phase`],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 5.55: round 前進異常の人間判断（plan-run 所有）
    //         agent_verdict が「findings の round が前回 verdict から進んでいない」
    //         （= レビュー済みラウンドへの再入で round 前進の写像が欠落）を検出した
    //         ときだけ condition が true になり、人間が復旧方法を選ぶ。
    //         error + goto execute_work の反復（高コストな SubAgent 実行が人間の
    //         介入まで続く）を避け、人間エスカレーションへ一本化する。
    //         condition は agent_verdict の検出と同じ roundStalled 写像を使う。
    // -------------------------------------------------------------------
    {
      key: "round_stall_gate",
      phase: "round 前進異常の判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: roundStallDetected,
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
      // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [REVIEW_FINDINGS_KEY, REVIEW_VERDICT_KEY, REVIEW_EFFORT_KEY],
        outcomeQuestionKey: "decision",
        reviseTargetStep: "execute_work",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "findings の round が前回 verdict から前進していません（レビュー済みラウンドへの再入で round 前進の写像が欠落しています）。このまま放置すると、同じ round のレビューを繰り返して round 上限（3）へ到達できません。effort.json の round を確認・修正し、execute_work からの再実行を選ぶと、execute_work の check が round を次ラウンドへ前進させてレビューサイクルをやり直します。このまま次のレビューサイクルへ進む（approve）こともできますが、collect_verdict の非通過復旧が round を前進させるため、修正内容によっては再度このゲートが提示されます。中断（abort）する場合は difit セッションの後始末を `mt difit done`（冪等・exit 0）で手動実行してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "このまま次のレビューサイクルへ進む",
                desc: "round の前進を collect_verdict の非通過復旧（+1）に委ねて続行する。復旧が成立しない場合は再度このゲートが提示される",
                input: { required: false, maxLength: 500 },
              },
              {
                value: "revise",
                label: "execute_work からやり直す",
                desc: "execute_work の check が round を次ラウンドへ前進させ、レビューサイクルをやり直す。difit セッション（サーバ・state）は保持され、次ラウンドの start_difit_review が再利用する",
                input: {
                  required: true,
                  placeholder: "対処内容（effort.json の round 修正など）を入力",
                  maxLength: 500,
                },
              },
              {
                value: "abort",
                label: "中断",
                desc: "中断する。エンジンが終了するため difit セッションの後始末は実行されない。中断前に `mt difit done`（冪等・exit 0）を手動実行すること",
              },
            ],
          },
        ],
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

    // -------------------------------------------------------------------
    // Step 6: 人間レビュー待機（mt-review-diff から import — 旧 await_review 置換）
    //         2段階ループ: 自律段階（findings must>0）は人へ渡さず human gate を skip し、
    //         must=0 の人相段階でのみ人レビューを行う。skip はループ所有者である plan-run
    //         専用の意味論（mt-review-diff 単独では must>0 でも必ず人間に提示する）ため、
    //         import 元の step に condition が無いことを前提にここで condition を override する。
    //         現行 tado 0.1.0 は human_gate の check を実行しない（check は task の report
    //         経路のみ）。ゲート通過検証は collect_verdict の `mt difit check --dry-run`
    //         突合に一本化されている。
    // -------------------------------------------------------------------
    {
      ...awaitHumanReviewStep,
      phase: "人間レビュー待機",
      condition: (ctx: ConditionCtx): boolean => {
        const findingsRaw =
          findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
        const findingsResult = validateFindingsJson(findingsRaw);
        // findings を機械的に確認できない場合は skip しない（人間に提示し、collect_verdict の
        // 検証で fail にする）。skip は must>0 を確認できたときだけ行う fail-closed 判定。
        if (!findingsResult.valid || !findingsResult.parsed) return true;
        return findingsResult.parsed.counts.must === 0;
      },
      // mt-review-diff 単独では revise の巻き戻し先がゲート自身になる（onFail: abort で
      // reviseTargetStep なし）ため、入力した修正理由の消費先が存在しない。plan-run では
      // ループ所有者として execute_work へ配線し、修正サイクルへ戻す。入力した修正理由は
      // gateAnswers（await_human_review.decision の input）に記録され、execute_work の
      // prompt が参照する（executor への修正指示に含める）。
      humanGate: {
        ...awaitHumanReviewStep.humanGate!,
        reviseTargetStep: "execute_work",
        questions: awaitHumanReviewStep.humanGate!.questions.map((question) => {
          if (question.key !== "decision") return question;
          return {
            ...question,
            choices: question.choices?.map((choice) =>
              choice.value === "revise"
                ? {
                    ...choice,
                    desc: "execute_work から修正サイクルをやり直す。入力した修正理由は gateAnswers に記録され、execute_work の修正指示として参照される",
                  }
                : choice,
            ),
          };
        }),
      },
    },

    // -------------------------------------------------------------------
    // Step 7: verdict 収集 & ゲート判定（mt-review-diff から import — difit ゲート）
    //         plan-run が loop 所有者として resetReviewCycle を保持。新ワークフロー側は verdict までで終端する設計を維持
    // -------------------------------------------------------------------
    {
      ...collectVerdictStep,
      key: "collect_verdict",
      phase: "verdict 収集",
      maxRetries: 0,
      onFail: { action: "goto", target: "execute_work", requeueSource: true },
      check: (ctx: CheckCtx): CheckResult => {
        // mt-review-diff の検証 (schema, round 上限, daemon 突合) をまず実行
        const origCheck = collectVerdictStep.check as (ctx: CheckCtx) => CheckResult;
        const origResult = origCheck(ctx);

        // mt-review-diff の check は「`mt difit check --dry-run`（非破壊）と verdict の突合を
        // 通過・ブロック両経路で行い、一致した場合のみ pass」する契約。pass 以外（round limit /
        // セッション不在 / 不一致 / schema error）は plan-run が loop 判定で上書きせず、
        // 理由に応じて復旧経路へ振り分ける。
        if (origResult.status !== "pass") {
          // fail / error のどちらでも、origCheck と同じ解決チェーン
          // （artifacts → セッションファイル → subagentOutput）で verdict を取得して
          // round limit を再評価する。error を上限判定から外すと、決定論的に再発する
          // error（report 未完・schema 不正・永続化失敗等）が round を前進させながら
          // execute_work → collect_verdict を人間の介入まで無制限に反復する。
          const verdictRaw = resolveReviewVerdictRaw(ctx);
          const verdictResult = validateVerdictJson(verdictRaw);
          if (verdictResult.valid && verdictResult.parsed) {
            // 上限判定は実効ラウンド（verdict.round と findings.round の大きい方）で行う。
            // verdict.round が findings.round に追従しない場合でも、findings.round は
            // ループバックごとに前進するため、上限到達を素通りさせない。
            const findings = resolveReviewFindings(ctx);
            const effectiveRound = effectiveReviewRound(verdictResult.parsed, findings);
            const effective = { ...verdictResult.parsed, round: effectiveRound };
            if (isRoundLimitReached(effective)) {
              // ラウンド上限はレビューサイクルを再実行しても解消しない（round は自動で
              // 減らない）ため、execute_work へ goto せず人間判定へエスカレーションする。
              // collect_verdict 自体は pass として通過させ、次ステップの
              // round_limit_gate / round_limit_passed_gate の condition が human gate を
              // 提示する。condition は attemptResult を持たないため、subagentOutput 経由で
              // 解決した verdict でもファイルから読めるよう永続化し、判定経路を揃える。
              try {
                fs.writeFileSync(
                  join(ctx.sessionDir, REVIEW_VERDICT_KEY),
                  verdictRaw!.endsWith("\n") ? verdictRaw! : `${verdictRaw!}\n`,
                  "utf-8",
                );
              } catch (error) {
                return {
                  status: "error",
                  reasons: [
                    `failed to persist verdict for round limit escalation: ${String(error)}`,
                  ],
                };
              }
              return {
                status: "pass",
                reasons: [
                  effectiveRound !== verdictResult.parsed.round
                    ? `round limit reached: verdict.round=${verdictResult.parsed.round} が findings.round=${findings?.round} に追従していないため、実効ラウンド ${effectiveRound} を上限到達として扱います`
                    : `round limit reached (${REVIEW_ROUND_LIMIT}/${REVIEW_ROUND_LIMIT}) — verdict: passed=${effective.passed}`,
                  ...(origResult.status === "error"
                    ? [
                        "collect_verdict は error（report 未完・schema 不正・永続化失敗等）を返しましたが、round 上限に達しているため execute_work への反復を止め、human gate へエスカレーションします",
                      ]
                    : []),
                  "自動ループを止め、round_limit_gate / round_limit_passed_gate で人間が継続・受容・中断を判断します",
                  ...origResult.reasons,
                ],
              };
            }
          }
          if (origResult.status === "fail" && (!verdictResult.valid || !verdictResult.parsed)) {
            // 上限判定不能を false（= 復旧経路）へ倒すと、round 上限到達済みでも
            // execute_work → 検証者 → collect_verdict を無音で回し続ける。
            return {
              status: "error",
              reasons: [
                `上限判定不能: round limit を判定できません。verdict を artifacts / セッションファイル / subagentOutput のどの経路からも解決できませんでした (${verdictResult.error ?? "invalid verdict"})`,
                ...origResult.reasons,
              ],
            };
          }
          if (origResult.status === "error" && (!verdictResult.valid || !verdictResult.parsed)) {
            // verdict を解決できない error は round 判定に載らない。effort.json の round を
            // ループカウンタとして連続 error を打ち切り、上限に達していれば人間ゲートへ
            // エスカレーションする（決定論的に再発する error の無制限反復を止める）。
            // round_limit_gate の condition も同じ写像（verdict 不在時は effort.json の
            // round を上限判定）を使う。
            const effortRaw =
              findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
              readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
            const effortValidation = validateEffort(parseJson(effortRaw), {
              allowRoundOverflow: true,
            });
            if (
              effortValidation.status === "pass" &&
              effortValidation.round >= REVIEW_ROUND_LIMIT
            ) {
              return {
                status: "pass",
                reasons: [
                  `collect_verdict が verdict を解決できない error を反復しています（effort.json round=${effortValidation.round} >= ${REVIEW_ROUND_LIMIT}）。execute_work への反復を止め、round_limit_gate で人間が復旧・中断を判断します`,
                  ...origResult.reasons,
                ],
              };
            }
          }
          // セッション不在（dry-run がゲート出力を返さない）・done 実行によるセッション終了・
          // 突合不一致・round limit 未到達の fail / error は、レビューサイクル
          // （start_difit_review を含む）を再キューしないと復旧できない。resetReviewCycle で
          // execute_work より後を pending に戻し、execute_work（修正）→ 再検証 →
          // start_difit_review（セッション復旧）へ載せる。この経路も「次ラウンド」なので、
          // reset だけでは据え置かれる effort.json の round を前進させる（据え置きは次ラウンドの
          // agent_verdict に round 停滞として検出され、execute_work の反復を招く）。
          try {
            resetReviewCycle(ctx.sessionDir);
            advanceReviewRound(ctx.sessionDir);
          } catch (error) {
            return {
              status: "error",
              reasons: [`failed to prepare next review round: ${String(error)}`],
            };
          }
          return origResult;
        }

        // origCheck が pass を返した時点で verdict.json は検証済み。daemon 突合済みの
        // passed / blocking_threads だけを使って execute_work への反復を判定する。
        const verdictRaw = resolveReviewVerdictRaw(ctx);
        const verdictResult = validateVerdictJson(verdictRaw);
        if (!verdictResult.valid || !verdictResult.parsed) {
          return {
            status: "error",
            reasons: [
              `verdict re-read failed after origCheck pass: ${verdictResult.error ?? "invalid verdict"}`,
            ],
          };
        }
        const verdict = verdictResult.parsed;
        if (verdict.passed) {
          return {
            status: "pass",
            reasons: [
              `verdict passed: round=${verdict.round} blocking=${verdict.blocking_threads.length}`,
            ],
          };
        }

        // blocked -> loop へ。workflow.db のループ制御は plan-run が所有。
        // ループバックは次ラウンドの実行なので、effort.json の round を進めて
        // normalize_findings → findings.json → verdict.json の順に継承させる
        // （round を 1 にリセットすると round limit が無音で無効化され、gate に到達しない）。
        try {
          resetReviewCycle(ctx.sessionDir);
          advanceReviewRound(ctx.sessionDir);
        } catch (error) {
          return { status: "error", reasons: [`failed to reset review cycle: ${String(error)}`] };
        }
        const blocking = verdict.blocking_threads.map(
          (t: { taxonomy?: string; file?: string; body: string }) =>
            `${t.taxonomy ?? "blocking"} ${t.file ?? "(file-level)"}: ${t.body}`,
        );
        return {
          status: "fail",
          reasons: blocking.length > 0 ? blocking : ["verdict is blocked — goto execute_work"],
        };
      },
    },

    // -------------------------------------------------------------------
    // Step 7.5: ラウンド上限エスカレーション（plan-run 所有）
    //         collect_verdict が round limit（未通過 / verdict を解決できない error の反復）
    //         を検出した場合のみ condition が true になり、人間が「もう1巡続ける
    //         （execute_work から再実行）/ 受容して完了 / 中断」を選ぶ。
    //         condition は passed の有無で round_limit_passed_gate と排他にする
    //         （tado の GateQuestion.description は文字列固定のため、通過済みの文言分岐は
    //         ゲートの分離で行う）。
    //         上限未達（通過 verdict）では skipped となり、後続の release_difit_session も
    //         skipped のまま finalize_done へ進む。
    // -------------------------------------------------------------------
    {
      key: "round_limit_gate",
      phase: "ラウンド上限判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: roundLimitUnpassed,
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
      // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [REVIEW_VERDICT_KEY, REVIEW_FINDINGS_KEY, DIFIT_CHECK_KEY],
        outcomeQuestionKey: "decision",
        reviseTargetStep: "execute_work",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "レビューがラウンド上限（3）に達しても未通過です（collect_verdict が verdict を解決できない error を反復している場合もこのゲートに達します。その場合は collect_verdict の理由に error の内容が記録されています）。指摘を受容して完了処理へ進むか、もう1巡レビューを続けるか（execute_work から再実行）、中断するかを選択してください。「もう1巡」を選ぶと execute_work の check が round を次ラウンド（+1）へ前進させてからレビューサイクルを再実行します。受容すると次のステップ（release_difit_session）が `mt difit done` で difit セッション（サーバ・state）を後始末します。もう1巡ではセッションは保持され次ラウンドで再利用されます。このゲートの前提として、collect_verdict が `mt difit check --dry-run` で verdict（passes / blocking_threads / selection_drift）を difit サーバ実体と突合し、その結果を理由と difit-check.json に反映しています。突合を取得できなかった場合は理由に「検証できていない」と明記されるため、受容の前に difit-check.json と collect_verdict の理由を確認してください。中断（abort）はエンジンが終了するため後始末が実行されません。中断する場合は、先に `mt difit done`（冪等・exit 0）を手動実行してから選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "受容して完了処理へ",
                desc: "未 resolve の指摘を残したまま最終確認（finalize_done）へ進む。difit セッションは次のステップ（release_difit_session）が `mt difit done` で後始末する",
                input: { required: false, maxLength: 500 },
              },
              {
                value: "revise",
                label: "もう1巡続ける",
                desc: "execute_work の check が round を次ラウンド（+1）へ前進させ、execute_work からレビューサイクルを再実行する。difit セッション（サーバ・state）は保持され、次ラウンドの start_difit_review が再利用する",
                input: { required: true, placeholder: "継続する理由を入力", maxLength: 500 },
              },
              {
                value: "abort",
                label: "中断",
                desc: "中断する。エンジンが終了するため difit セッションの後始末は実行されない。中断前に `mt difit done`（冪等・exit 0）を手動実行すること",
              },
            ],
          },
        ],
      },
    },

    // -------------------------------------------------------------------
    // Step 7.55: ラウンド上限到達・通過済みの人間判断（plan-run 所有）
    //         round_limit_gate の description は verdict.passed を静的に反映できない
    //         （tado の GateQuestion.description は文字列固定）ため、passed の有無で
    //         提示ゲートを分離する。通過済みでは「上限到達・通過済み。後始末へ」を提示し、
    //         未通過前提の「もう1巡」や「未 resolve を残したまま」の文言を出さない。
    // -------------------------------------------------------------------
    {
      key: "round_limit_passed_gate",
      phase: "ラウンド上限判断（通過済み）",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: roundLimitPassed,
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
      // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [REVIEW_VERDICT_KEY, REVIEW_FINDINGS_KEY, DIFIT_CHECK_KEY],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "レビューはラウンド上限（3）に達したうえで通過済み（verdict passed=true）です。追加の修正サイクルは不要なので、後始末へ進むか中断するかを選択してください。「受容して後始末へ」を選ぶと次のステップ（release_difit_session）が `mt difit done` で difit セッション（サーバ・state）を後始末し、最終確認（finalize_done）へ進みます。このゲートの前提として、collect_verdict が `mt difit check --dry-run` で verdict（passes / blocking_threads / selection_drift）を difit サーバ実体と突合し、その結果を理由と difit-check.json に反映しています。中断（abort）はエンジンが終了するため後始末が実行されません。中断する場合は、先に `mt difit done`（冪等・exit 0）を手動実行してから選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "上限到達・通過済み。後始末へ",
                desc: "通過済みの verdict を受容し、次のステップ（release_difit_session）の `mt difit done` で difit セッションを後始末して最終確認（finalize_done）へ進む",
                input: { required: false, maxLength: 500 },
              },
              {
                value: "abort",
                label: "中断",
                desc: "中断する。エンジンが終了するため difit セッションの後始末は実行されない。中断前に `mt difit done`（冪等・exit 0）を手動実行すること",
              },
            ],
          },
        ],
      },
    },

    // -------------------------------------------------------------------
    // Step 7.6: ラウンド上限受容時の difit 後始末（plan-run 所有）
    //         round_limit_gate / round_limit_passed_gate で「受容」を選んだときだけ
    //         到達する（condition は両ゲートと同じ roundLimitReached。通常通過では skip）。
    //         受容 = レビュー終了なので、collect_verdict の round limit early return が
    //         残した difit セッション（サーバ・state）を `mt difit done`
    //         （冪等・exit 0）で後始末する。「もう1巡」ではこのステップは実行されず、
    //         セッションは次ラウンドで再利用される。abort はエンジン終了のため到達しない
    //         （gate description で手動 done を案内）。
    // -------------------------------------------------------------------
    {
      key: "release_difit_session",
      phase: "difit 後始末",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      condition: roundLimitReached,
      task: {
        action: "orchestrate",
        readonly: true,
        buildPrompt: (ctx: PromptCtx) =>
          [
            "## 目的",
            "",
            "round_limit_gate で「受容して完了処理へ」が選ばれた。difit セッションの後始末（`mt difit done` の実行・state 消失・pid 終了の検証）はこのステップの check が決定論的に実行する。",
            "",
            "## 指示",
            "",
            "- 状態を変更しない（read-only）。`mt difit done` / `mt difit check` / `mt difit start` / コメント resolve を実行しない",
            "- report のみ行い、後始末が check に委ねられていることを報告する",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n"),
      },
      check: (_ctx: CheckCtx): CheckResult => {
        // 受容経路の後始末は task の実行漏れに依存しないよう check 側で決定論的に実行する
        // （done は冪等・exit 0 の契約なので二重実行しても副作用はない）。collect_verdict の
        // 通過時後始末と同一の _shared/cleanupDifitSession を使い、done 実行・state 消失・
        // done 前 pid の終了まで検証する（受容経路だけ検証が弱い非対称を作らない）。
        const cleanup = cleanupDifitSession();
        if (cleanup.status === "error") {
          return { status: "error", reasons: cleanup.reasons };
        }
        return {
          status: "pass",
          reasons: [`difit session released (state removed)`, ...cleanup.stderr],
        };
      },
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
          return [
            "## 目的",
            "",
            "計画 Issue を `done` に遷移し、完了処理を行う。",
            "",
            "## 手順",
            "",
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
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
            "```json",
            `{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      // 統一最低ライン+ 副作用実照合: done 遷移の実態（Issue が CLOSED）を gh で確認
      check: (ctx: CheckCtx): CheckResult => {
        const result = requireStepArtifacts(ctx, [
          { key: "plan-number.txt", form: "text", pattern: /^[0-9]+$/ },
        ]);
        if (result.status !== "pass") return result;
        const raw = findArtifactText(ctx.artifacts, "plan-number.txt", ctx.sessionDir);
        const number = (raw ?? "").trim();
        const ghReasons = verifyIssueClosed(number);
        return ghReasons.length > 0
          ? { status: "fail", reasons: ghReasons }
          : { status: "pass", reasons: [`issue #${number} is closed on GitHub`] };
      },
    },
  ],
};

export default def;
