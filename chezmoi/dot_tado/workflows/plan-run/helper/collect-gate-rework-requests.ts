import type { ArtifactRecord, GateAnswers } from "tado";
import { isRecord } from "../../shared/review-helpers/is-record";
import { OUTCOME_QUESTION_KEYS } from "../types.ts";
import { gateAnswerValue } from "./gate-answer-value.ts";
import { isHumanReviewPhase } from "./is-human-review-phase.ts";

/// gateAnswers 世代管理の skip 判定 registry（collect-gate-rework-requests の唯一の参照先）。
/// loop 内 human_gate のうち condition を持つものは、step の condition と同一関数を
/// 登録する（散在する if 列挙にせず写像ドリフトを防ぐ）。loop 外ゲートは登録しない
/// （request_changes が現れたら stale 扱いで捨てず fail で検出する）。
/// 新規 loop 内ゲート追加時はこの表への登録が必須
/// （index.test.ts の更新強制テストが条件付き loop 内ゲート集合を固定する）。
const GATE_SKIP_CONDITIONS: Record<
  string,
  (ctx: { sessionDir: string; artifacts: ArtifactRecord[] }) => boolean
> = {
  "await-human-review": (ctx) => isHumanReviewPhase(ctx),
};

/// gateAnswers を走査し、request_changes のゲートを列挙する（純粋関数）。
/// 固定ゲート一覧の走査にしない（契約の `gate:<stepKey>` 一般形どおり、将来の loop 内ゲート
/// 追加に追従する。loop 外ゲートの除外は LOOP_OUTSIDE_GATE_KEYS で行う）。
/// OUTCOME_QUESTION_KEYS に登録のあるゲートは outcome 設問キー回答のみを
/// 差し戻し対象にする。補助設問の request_changes は幽霊差し戻しになるため拾わない
/// （ai-1）。未登録のゲートは outcome 不明のため decision 優先の全キー走査で
/// 検出する（見落としの fail-closed。gate-decision-value と同じ写像）。
/// NOTE(logic-1): skip されたゲートの stale 回答を残留させない。gateAnswers は loop 反復を
/// またいで最新回答を保持するため、前反復の request_changes が残っていても、当該反復で
/// ゲートが skip（condition false）なら差し戻し対象外とする。skip 判定は各ゲートの
/// condition と同一写像（await-human-review →
/// is-human-review-phase）で行い、写像ドリフトを作らない。ctx 省略時は旧来どおり全件収集
/// （呼び出し側は ctx を渡すこと。apply-feedback / execute-work / judge は渡す）。
export function collectGateReworkRequests(
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
    const outcomeKey = OUTCOME_QUESTION_KEYS[gateKey];
    if (outcomeKey !== undefined) {
      // outcome 回答のみ対象。補助設問は幽霊差し戻しになるため走査しない。
      // outcome 不在・契約外形状・approve 等は差し戻し無しとして扱う。
      const ans = perGate[outcomeKey];
      if (ans === undefined) continue;
      if (gateAnswerValue(ans) !== "request_changes") continue;
      out.push({ gateKey, questionKey: outcomeKey, input: readInput(ans) });
      continue;
    }
    // 未登録ゲートのフォールバック: decision 優先・全キー走査。request_changes を
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
