import type { CheckCtx, CheckResult } from "tado";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateDecisionValue } from "./gate-decision-value.ts";
import { gateDecisionInput } from "./gate-decision-input.ts";

function decideGateRework(
  value: string | undefined,
): "pass" | "continue" | "abort" | "unknown" | "missing" {
  if (value === undefined) return "missing";
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "abort";
  return "unknown";
}

// human_gate の revise 撤去に伴う差し戻し→再作業→再提示の loop 巻き戻し判定。
// judge（loop 末尾 check）が ctx.gateAnswers の当該ゲート decision を読み、
// approve→pass / request_changes→continue / abort→error / 未知・未回答→fail。
// 上限到達時は continue を返さない（onExhausted=escalate で停止すると loop 外へ
// 届かないため）。代わりに枯渇マーカーを残して pass で脱出し、loop 外の人間
// 判断ゲート（approve/abort）へ渡す。
export function judgeGateRework(
  ctx: CheckCtx,
  opts: {
    gateKey: string;
    loopKey: string;
    headKey: string;
    markerKey: string;
    exhaustedKey: string;
  },
): CheckResult {
  // 配置・世代ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
  if (ctx.loop?.key !== opts.loopKey) {
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} の判定は ${opts.loopKey} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
      ],
    };
  }
  const decision = decideGateRework(gateDecisionValue(ctx.gateAnswers, opts.gateKey));
  if (decision === "missing") {
    return {
      status: "fail",
      reasons: [`${opts.gateKey} が実行されましたが gateAnswers に回答がありません`],
    };
  }
  if (decision === "pass") {
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
}
