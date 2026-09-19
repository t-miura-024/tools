import type { GateAnswers } from "tado";
import { isGateAnswerRecord } from "../types.ts";

/// loop 内 human_gate の decision 追加入力の読み取り（純粋関数）。
/// 文字列以外の input は欠落扱い（undefined）とする。
export function gateDecisionInput(
  gateAnswers: GateAnswers,
  stepKey: string,
  questionKey = "decision",
): string | undefined {
  const ans = gateAnswers[stepKey]?.[questionKey];
  if (typeof ans !== "string" && isGateAnswerRecord(ans) && typeof ans.input === "string") {
    return ans.input;
  }
  return undefined;
}
