import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";
import { decideGateRework } from "../../helper/decide-gate-rework.ts";
import { isEnoent } from "../../helper/is-enoent.ts";

// -------------------------------------------------------------------
// 承認差し戻し判定（plan-approval-cycle 末尾）
//   phase3b-plan-approval の gateAnswers を読んで分岐する loop の check。
//   approve → pass / request_changes → 判定 `continue` で本体先頭
//   （phase3-planner）へ巻き戻る / abort → error / 未知・未回答 → fail。
//   request_changes は追加入力の非空を軽量検証する（body 非空。
//   source は当該ゲート固定読みで対応）。最終反復の request_changes は
//   pass で loop を抜け、loop 外の plan-approval-exhausted-gate で人間が
//   受容・中断を判断する（loop 外の continue はエンジンが fail-fast する）。
// -------------------------------------------------------------------
export const judgePlanApprovalStep: TaskStepDef = {
  key: "judge-plan-approval",
  phase: "承認差し戻し判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    // NOTE: agent への指示は report のみだが、check が上限到達時に枯渇マーカーの
    // 永続化という副作用を持つため readonly:true の宣言は実態と合わない。外す。
    readonly: false,
    buildPrompt: (ctx: PromptCtx) =>
      buildStepPrompt({
        purpose: [
          "phase3b-plan-approval の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
        ],
        criteria: [],
        approach: [
          "agent は report のみ行い、ファイルの作成・編集を行わない（read-only）",
          "分岐判定が check に委ねられていることを報告する",
        ],
        output: ["分岐判定の材料となる報告。"],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    // 配置・世代ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
    if (ctx.loop?.key !== "plan-approval-cycle") {
      return {
        status: "error",
        reasons: [
          `phase3b-plan-approval の判定は plan-approval-cycle 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
        ],
      };
    }
    const value = gateDecisionValue(ctx.gateAnswers, "phase3b-plan-approval");
    const decision = decideGateRework(value);
    if (decision === "missing") {
      return {
        status: "error",
        reasons: [
          `phase3b-plan-approval が実行されましたが gateAnswers に回答がありません。ゲート未 confirmed のまま判定ステップへ進んでいます`,
        ],
      };
    }
    if (decision === "pass") {
      // 正常 pass 時の後始末: stale な枯渇マーカーが残っていれば削除する。不在は正常。
      try {
        unlinkSync(join(ctx.sessionDir, "plan-approval-exhausted.json"));
      } catch (error) {
        if (!isEnoent(error)) {
          return {
            status: "error",
            reasons: [
              `枯渇マーカーの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
            ],
          };
        }
      }
      return { status: "pass", reasons: ["phase3b-plan-approval approved — proceed"] };
    }
    if (decision === "abort") {
      return {
        status: "error",
        reasons: [
          "phase3b-plan-approval で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません",
        ],
      };
    }
    if (decision === "unknown") {
      return {
        status: "fail",
        reasons: [
          `phase3b-plan-approval の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は撤去済みのため request_changes を使ってください）`,
        ],
      };
    }
    const input = gateDecisionInput(ctx.gateAnswers, "phase3b-plan-approval");
    if (input === undefined || input.trim() === "") {
      return {
        status: "fail",
        reasons: [
          "phase3b-plan-approval の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする",
        ],
      };
    }
    if (ctx.loop.iteration >= ctx.loop.maxIterations) {
      // 最終反復で continue を返すと onExhausted=escalate で停止し loop 外ゲートへ届かない。
      // request_changes の追加入力を枯渇マーカーへ永続化して pass で脱出し、
      // loop 外の plan-approval-exhausted-gate と後続 step で再提示する。
      try {
        writeFileSync(
          join(ctx.sessionDir, "plan-approval-exhausted.json"),
          `${JSON.stringify({ loop: "plan-approval-cycle", gate: "phase3b-plan-approval", iteration: ctx.loop.iteration, input: input.trim() })}\n`,
          "utf-8",
        );
      } catch (error) {
        return {
          status: "error",
          reasons: [
            `枯渇マーカーの永続化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
      return {
        status: "pass",
        reasons: [
          `上限到達（反復 ${ctx.loop.iteration}/${ctx.loop.maxIterations}）のため request_changes のまま plan-approval-cycle を抜け、plan-approval-exhausted-gate で人間が受容・中断を判断します。未反映の差し戻し（gate:phase3b-plan-approval）: ${input}`,
        ],
      };
    }
    return {
      status: "continue",
      reasons: [
        "phase3b-plan-approval request_changes — rewind plan-approval-cycle to phase3-planner",
      ],
    };
  },
};
