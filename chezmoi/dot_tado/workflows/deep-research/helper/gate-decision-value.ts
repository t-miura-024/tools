import type { GateAnswers } from "tado";
import { isGateAnswerRecord } from "../types.ts";

/// loop 内 human_gate の decision 回答値の読み取り（純粋関数）。
/// choice_with_input 回答は `{ value, input? }`、single_choice 回答は文字列。
/// 未回答・契約外形状は undefined（呼び出し元の error/fail 経路へ載せる）。
export function gateDecisionValue(gateAnswers: GateAnswers, stepKey: string): string | undefined {
  const answer = gateAnswers[stepKey]?.["decision"];
  if (typeof answer === "string") return answer;
  if (isGateAnswerRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}
