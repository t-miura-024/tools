import { isRecord } from "../../shared/review-helpers/is-record";

/// gate 回答値の抽出（型不正に fail-closed）。
/// GateAnswers の契約外形状（null・数値・value 非文字列等）は TypeError にせず
/// undefined を返し、呼び出し元の error/fail 経路へ載せる。
export function gateAnswerValue(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer;
  if (isRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}
