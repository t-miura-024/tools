import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { judgeGateRework } from "../../helper/judge-gate-rework.ts";

// -----------------------------------------------------------------
// Step 2c: 差し戻し判定（update-cycle の loop 末尾）
//   confirm-update の gateAnswers を読んで分岐する loop の check。
//   request_changes → 判定 `continue` で loop 先頭（draft-body）へ巻き戻る。
//   上限到達時は枯渇マーカーを残して pass で脱出し、loop 外の
//   update-exhausted へ渡す。4分岐に pass フォールバックは設けない。
// -----------------------------------------------------------------
export const judgeUpdateStep: TaskStepDef = {
  key: "judge-update",
  phase: "差し戻し判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    // NOTE: agent への指示は report のみだが、check が上限到達時に枯渇マーカーの
    // 永続化という副作用を持つため readonly:true の宣言は実態と合わない。外す。
    readonly: false,
    buildPrompt: (ctx: PromptCtx) =>
      [
        "## 目的",
        "",
        "confirm-update の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
        "",
        "## 指示",
        "",
        "- agent は report のみ行い、ファイルの作成・編集を実行しない（agent の作業は read-only）",
        "- 分岐判定と枯渇マーカーの永続化は check が決定論的に行う。分岐判定が check に委ねられていることを報告する",
        "",
        "## セッション情報",
        "",
        `- セッションディレクトリ: ${ctx.sessionDir}`,
      ].join("\n"),
  },
  check: (ctx: CheckCtx): CheckResult =>
    judgeGateRework(ctx, {
      gateKey: "confirm-update",
      loopKey: "update-cycle",
      headKey: "draft-body",
      markerKey: "update-cycle-exhausted.json",
      exhaustedKey: "update-exhausted",
    }),
};
