import type { CheckResult } from "tado";
/// gate 回答値の純粋判定。round 前進などの副作用を持たない。
///   - missing（未回答）→ error（ゲートは実行されたのに回答が無い異常）
///   - pass（approve）→ loop 脱出
///   - continue（request_changes）→ loop 先頭へ巻き戻り
///   - abort → error（中断意図の記録。未知値 fail とは分離）
///   - unknown → fail（値語彙の想定外。旧 revise 値もここで検出）
function decideGateOutcome(
  value: string | undefined,
): "pass" | "continue" | "abort" | "unknown" | "missing" {
  if (value === undefined) return "missing";
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "abort";
  return "unknown";
}

/// loop 内 human_gate の request_changes 差し戻しを判定 `continue` へ変換する。
/// 旧 revise 値は受理しない（後方互換は作らない。in-flight に残る旧値は
/// fail で検出し、理由に移行先（request_changes）を案内する。互換シムなし）。
export function judgeGateContinuation(
  value: string | undefined,
  opts: { gateKey: string; loopKey: string; headKey: string; abortHint: string },
): CheckResult {
  const decision = decideGateOutcome(value);
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
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません。${opts.abortHint}`,
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
