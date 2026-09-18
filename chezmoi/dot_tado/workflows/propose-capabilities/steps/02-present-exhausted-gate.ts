import type { CheckCtx, CheckResult, GateAnswers } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { gateDecisionValue } from "../helper/gate-decision-value.ts";

// -------------------------------------------------------------------
// 提示上限判断（loop 外・枯渇時のみ提示）
//   candidate-cycle が上限（3 反復）に達しても request_changes のままの
//   場合のみ condition が true になり、人間が受容して起票へ進むか中断するかを選ぶ。
//   human_gate は確認と回答保存のみを行い、巻き戻しは行わない。
//   loop 外のため選択肢は approve/abort のみとし、request_changes は
//   持たせない（巻き戻しが起きず記録上通過するだけの未配線選択肢になるため）。
//   上限未達（approve 脱出）では skipped となり、draft 起票へ進む。
// -------------------------------------------------------------------
export const presentExhaustedGateStep: HumanGateStepDef = {
  key: "present-exhausted-gate",
  phase: "提示上限判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  // loop 枯渇の検出。judge は request_changes でしか continue を返さないため、loop 脱出後に
  // 内側ゲートの最新回答が request_changes なら上限到達（最終反復の pass 抜け）とみなす。
  // approve 脱出（正常 pass）・abort／未知・未回答では false（常時提示はしない）。
  // 内側 present-gate は無条件で毎反復再実行されるため常に最新回答が現世代であり、
  // 世代管理の registry は設けない（投機的一般化を避ける）。
  condition: (ctx: { gateAnswers: GateAnswers }): boolean => {
    return gateDecisionValue(ctx.gateAnswers, "present-gate") === "request_changes";
  },
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
  // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: [],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "候補提示が上限（3 反復）に達しても候補のやり直し（request_changes）のままです。loop は既に終了しているため、このゲートでブレストへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。未反映の差し戻し内容は gate の回答履歴（present-gate の request_changes 追加入力）で確認してください。現状の候補を受容して起票へ進むか、中断するかを選択してください",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "受容して起票へ進む",
            desc: "現状の候補で draft 起票へ進む",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "起票せず終了する" },
        ],
      },
    ],
  },
};
