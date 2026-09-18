import type { GateAnswers } from "tado";
import { gateDecisionValue } from "./gate-decision-value.ts";
import { gateDecisionInput } from "./gate-decision-input.ts";

// loop 先頭 worker の prompt へ注入する差し戻しデータ行（見出しなし。raw 文字列
// prompt のため Section 化は不可。呼び出し側は ## 入力・## 手順の直前に配置する）。
// 初回実行（未回答・approve・入力空）は「なし」行を返す。捏造の "(追加入力なし)" は
// 作らない（欠落は judge が fail で止める）。行頭#（## 等）を含めないこと。
export function reworkFeedbackSection(gateAnswers: GateAnswers, gateKey: string): string[] {
  const value = gateDecisionValue(gateAnswers, gateKey);
  const input = gateDecisionInput(gateAnswers, gateKey);
  if (value === "request_changes" && input !== undefined && input.trim() !== "") {
    return [
      `前回の差し戻し (gate:${gateKey}。loop 再実行時はこの指摘を反映する):`,
      `- ${gateKey}: ${input.trim()}`,
      "",
    ];
  }
  return [`前回の差し戻し (gate:${gateKey}):`, "- (なし。初回実行)", ""];
}
