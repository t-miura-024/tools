import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { isRecord } from "../../../shared/review-helpers/is-record";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";

const GATE_KEY = "review-gate";
const LOOP_KEY = "review-cycle";
const HEAD_KEY = "grill";
const MARKER_KEY = "review-cycle-exhausted.json";
const EXHAUSTED_KEY = "review-exhausted";

// -----------------------------------------------------------------
// Step 5b: 差し戻し判定（loop 末尾）
//   review-gate の gateAnswers を読んで分岐する loop の check。
//   request_changes → 判定 `continue` で loop 先頭（grill）へ巻き戻る。
//   上限到達時は枯渇マーカーを残して pass で脱出し、loop 外の
//   review-exhausted へ渡す。ゲート skip 時は発生しない（loop 内ゲートは
//   無条件のため毎反復実行される）。4分岐に pass フォールバックは設けない。
// -----------------------------------------------------------------
export const judgeReviewStep: TaskStepDef = {
  key: "judge-review",
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
      buildStepPrompt({
        purpose: [
          "review-gate の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
        ],
        // criteria空: 分岐判定は check が決定論的に行い agent 作業は report のみのため検証可能な完了条件なし
        criteria: [],
        approach: [
          "- 分岐判定と枯渇マーカーの永続化は check が決定論的に行う。分岐判定が check に委ねられていることを報告する",
        ],
        policy: [
          "- agent は report のみ行い、ファイルの作成・編集を実行しない（agent の作業は read-only）",
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    const opts = {
      gateKey: GATE_KEY,
      loopKey: LOOP_KEY,
      headKey: HEAD_KEY,
      markerKey: MARKER_KEY,
      exhaustedKey: EXHAUSTED_KEY,
    };
    // 配置・世代ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
    if (ctx.loop?.key !== opts.loopKey) {
      return {
        status: "error",
        reasons: [
          `${opts.gateKey} の判定は ${opts.loopKey} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
        ],
      };
    }
    const gateValue = gateDecisionValue(ctx.gateAnswers, opts.gateKey);
    const decision =
      gateValue === undefined
        ? "missing"
        : gateValue === "approve"
          ? "pass"
          : gateValue === "request_changes"
            ? "continue"
            : gateValue === "abort"
              ? "abort"
              : "unknown";
    if (decision === "missing") {
      return {
        status: "fail",
        reasons: [`${opts.gateKey} が実行されましたが gateAnswers に回答がありません`],
      };
    }
    if (decision === "pass") {
      // 正常 pass 時の後始末: stale な枯渇マーカーが残っていれば削除し、
      // 後段の review-exhausted condition の誤発火を防ぐ。不在は正常。
      try {
        unlinkSync(join(ctx.sessionDir, opts.markerKey));
      } catch (error) {
        if (!(isRecord(error) && error.code === "ENOENT")) {
          return {
            status: "error",
            reasons: [
              `枯渇マーカーの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
            ],
          };
        }
      }
      return { status: "pass", reasons: [`${opts.gateKey} approved — proceed`] };
    }
    if (decision === "abort") {
      return {
        status: "error",
        reasons: [
          `${opts.gateKey} で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません`,
        ],
      };
    }
    if (decision === "unknown") {
      const value = gateDecisionValue(ctx.gateAnswers, opts.gateKey);
      return {
        status: "fail",
        reasons: [
          `${opts.gateKey} の回答値が想定外です: ${value}（approve / request_changes / abort のいずれか）`,
        ],
      };
    }
    const input = gateDecisionInput(ctx.gateAnswers, opts.gateKey);
    if (input === undefined || input.trim() === "") {
      return {
        status: "fail",
        reasons: [
          `${opts.gateKey} の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする`,
        ],
      };
    }
    if (ctx.loop.iteration >= ctx.loop.maxIterations) {
      // 最終反復で continue を返すと onExhausted=escalate で停止し loop 外ゲートへ届かない。
      // 枯渇マーカーを残して pass で脱出し、loop 外の人間判断ゲートへ渡す。
      try {
        writeFileSync(
          join(ctx.sessionDir, opts.markerKey),
          `${JSON.stringify({ loop: opts.loopKey, gate: opts.gateKey, iteration: ctx.loop.iteration })}\n`,
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
          `${opts.gateKey} request_changes (iteration ${ctx.loop.iteration}/${ctx.loop.maxIterations} で上限到達) — ${opts.exhaustedKey} で人間が判断します`,
        ],
      };
    }
    return {
      status: "continue",
      reasons: [`${opts.gateKey} request_changes — rewind ${opts.loopKey} to ${opts.headKey}`],
    };
  },
};
