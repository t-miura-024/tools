import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";
import { decideGateRework } from "../../helper/decide-gate-rework.ts";

// -------------------------------------------------------------------
// 提示差し戻し判定（candidate-cycle 末尾）
//   present-gate の gateAnswers を読んで分岐する loop の check。
//   approve → pass / request_changes → 判定 `continue` で本体先頭
//   （brainstorm）へ巻き戻る / abort → error / 未知・未回答 → fail。
//   request_changes は追加入力の非空を軽量検証する（body 非空。
//   source は当該ゲート固定読みで対応）。最終反復の request_changes は
//   pass で loop を抜け、loop 外の present-exhausted-gate で人間が
//   受容・中断を判断する（loop 外の continue はエンジンが fail-fast する）。
// -------------------------------------------------------------------
export const judgePresentStep: TaskStepDef = {
  key: "judge-present",
  phase: "提示差し戻し判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    readonly: true,
    buildPrompt: (ctx: PromptCtx) =>
      buildStepPrompt({
        purpose: [
          "present-gate の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
        ],
        criteria: [],
        approach: ["- report のみ行い、分岐判定が check に委ねられていることを報告する"],
        policy: ["- 状態を変更しない（read-only）。ファイルの作成・編集をしない"],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    // 配置ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
    // iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
    // engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
    // judge は iteration >= maxIterations で先回りして pass 抜けする。
    // overshoot（iteration > max）でも pass 抜けとして fail-closed にする。
    if (ctx.loop?.key !== "candidate-cycle") {
      return {
        status: "error",
        reasons: [
          `present-gate の判定は candidate-cycle 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
        ],
      };
    }
    const value = gateDecisionValue(ctx.gateAnswers, "present-gate");
    const decision = decideGateRework(value);
    if (decision === "pass") {
      return { status: "pass", reasons: ["present-gate approved — proceed"] };
    }
    if (decision === "error") {
      return {
        status: "error",
        reasons: [
          "present-gate で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません",
        ],
      };
    }
    if (decision === "fail") {
      return {
        status: "fail",
        reasons: [
          value === undefined
            ? "present-gate が実行されましたが gateAnswers に回答がありません"
            : `present-gate の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は撤去済みのため request_changes を使ってください）`,
        ],
      };
    }
    const input = gateDecisionInput(ctx.gateAnswers, "present-gate");
    if (input === undefined || input.trim() === "") {
      return {
        status: "fail",
        reasons: [
          "present-gate の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする",
        ],
      };
    }
    if (ctx.loop.iteration >= ctx.loop.maxIterations) {
      return {
        status: "pass",
        reasons: [
          `上限到達（反復 ${ctx.loop.iteration}/${ctx.loop.maxIterations}）のため request_changes のまま candidate-cycle を抜け、present-exhausted-gate で人間が受容・中断を判断します。未反映の差し戻し（gate:present-gate）: ${input}`,
        ],
      };
    }
    return {
      status: "continue",
      reasons: ["present-gate request_changes — rewind candidate-cycle to brainstorm"],
    };
  },
};
