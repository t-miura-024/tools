import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText, readSessionFile } from "tado/artifacts";

// -----------------------------------------------------------------
// Step 2b: 更新差分の人間確認（第二ゲート）
// -----------------------------------------------------------------
export const confirmUpdateStep: HumanGateStepDef = {
  key: "confirm-update",
  phase: "更新確認",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  humanGate: {
    presentArtifacts: ["issue-body.md", "body-diff.md"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "差分を承認して更新する",
            desc: "body-diffが妥当。Issue更新へ進む",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "本文を修正する",
            desc: "差分が誤り。draft-bodyに戻る（loop が draft-body 先頭へ巻き戻る）",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (ctx: CheckCtx): CheckResult => {
    try {
      const body =
        readSessionFile(ctx.sessionDir, "issue-body.md") ??
        findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
      const diff =
        readSessionFile(ctx.sessionDir, "body-diff.md") ??
        findArtifactText(ctx.artifacts, "body-diff.md", ctx.sessionDir);
      if (!body || !diff)
        return { status: "fail", reasons: ["confirm-update: required artifacts missing"] };
      return { status: "pass", reasons: [] };
    } catch (e) {
      return { status: "fail", reasons: [String(e)] };
    }
  },
};
