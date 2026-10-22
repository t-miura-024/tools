import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

// -----------------------------------------------------------------
// Step 5: レビューゲート
// -----------------------------------------------------------------
// NOTE: 旧 create_draft ステップは create-refined に改名済み。旧キー・旧 artifact
// （issue-number.txt 提示）を参照する実行中セッションは resume せず abort し、
// 新規セッションで開始すること（破壊的変更の移行策）。
// abort 時は Issue 未作成のため残留 Draft は発生しない（from-Issue でも既存 Issue への変更前に終わるため残留物なし）。
export const reviewGateStep: HumanGateStepDef = {
  key: "review-gate",
  phase: "レビュー",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  humanGate: {
    // Issue 実物ではなく session ファイル（issue-body.md / review-body.md / prepare-decision.json）を対象にレビューする。
    // 承認後に create-refined が refined で直接作成するため、gate 時点では Issue は存在しない。
    // NOTE: 分解モードの子 body（issue-body-<n>.md）は件数が動的なため presentArtifacts に列挙できない。
    // 子の品質担保は review-body.md の子レビュー痕跡（check で機械検証）と create-refined の子未レビュー時 escalate ガード（fail→escalate）で行う。
    // width/depth 質問は置かない（draft-body が書き出す effort コメント初期値に一本化。死に質問化の再発防止）。
    presentArtifacts: ["issue-body.md", "review-body.md", "prepare-decision.json"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "refined で作成する",
            desc: "内容が完成・実行可能。review-body.md に must が残る場合は選択不可（request_changes を選ぶこと）。should 残存時の approve は人間が対応不要と判断した場合のみ",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "修正する",
            desc: "Grill Phase に戻って内容を再検討する（loop が grill 先頭へ巻き戻る。Issue は未作成のため残留物なし）。review-body.md に must/should が残る場合はこちらを選ぶ",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
        ],
      },
    ],
  },
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
  // （plan-run / review-diff と同一）。must 残存時の approve 抑止は上記 decision
  // の choice desc（人間の判断）に委ね、create-refined 到達時の must 残存は escalate で fail-closed にする。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
