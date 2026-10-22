import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { isReviewFixExhausted } from "../../helper/is-review-fix-exhausted.ts";

const GATE_KEY = "review-fix-exhausted";
const LOOP_KEY = "review-cycle";

// -----------------------------------------------------------------
// Step 6: 自動レビュー上限判定
//   review-fix-exhausted の回答を読み、retry なら外側 loop の continue で
//   review-fix-cycle 先頭（grill）へ巻き戻す。外側 loop の残り枠がない場合は
//   error にして、中断以外の選択肢を実行しない。
//   condition はゲートと同じ isReviewFixExhausted。ゲート skip 時は本ステップも skip。
// -----------------------------------------------------------------
export const judgeFixExhaustedStep: TaskStepDef = {
  key: "judge-fix-exhausted",
  phase: "自動レビュー上限判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  condition: isReviewFixExhausted,
  task: {
    action: "orchestrate",
    readonly: true,
    buildPrompt: (ctx: PromptCtx) =>
      buildStepPrompt({
        purpose: [
          `${GATE_KEY} の人間判断を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。`,
        ],
        criteria: [],
        approach: [
          "- 分岐判定は check が決定論的に行う。agent は report のみ行い、ファイルの作成・編集をしない",
        ],
        policy: ["- agent は read-only。workflow.db のループ制御に触れない"],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.loop?.key !== LOOP_KEY) {
      return {
        status: "error",
        reasons: [
          `${GATE_KEY} の判定は ${LOOP_KEY} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）`,
        ],
      };
    }
    const value = gateDecisionValue(ctx.gateAnswers, GATE_KEY);
    if (value === undefined) {
      return {
        status: "fail",
        reasons: [`${GATE_KEY} が実行されましたが gateAnswers に回答がありません`],
      };
    }
    if (value === "abort") {
      return {
        status: "error",
        reasons: [`${GATE_KEY} で中断 (abort) が選択されました`],
      };
    }
    if (value !== "retry") {
      return {
        status: "fail",
        reasons: [`${GATE_KEY} の回答値が想定外です: ${value}（retry / abort のいずれか）`],
      };
    }
    if (ctx.loop.iteration >= ctx.loop.maxIterations) {
      return {
        status: "error",
        reasons: [
          `外側の人間差し戻し枠が残っていないため追加ラウンドを実行できません（${ctx.loop.iteration}/${ctx.loop.maxIterations}）。中断を選んでください`,
        ],
      };
    }
    const input = gateDecisionInput(ctx.gateAnswers, GATE_KEY);
    const suffix = input !== undefined && input.trim() !== "" ? ` (追加指示: ${input.trim()})` : "";
    return {
      status: "continue",
      reasons: [`${GATE_KEY} retry — rewind ${LOOP_KEY} to review-fix-cycle${suffix}`],
    };
  },
};
