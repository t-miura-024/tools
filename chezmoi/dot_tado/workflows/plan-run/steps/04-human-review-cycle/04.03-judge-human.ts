import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateFindingsJson } from "../../../shared/review-helpers/validate-findings-json";
import { FINDINGS_KEY as REVIEW_FINDINGS_KEY } from "../../../shared/review-helpers/findings-key";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { gateAnswerValue } from "../../helper/gate-answer-value.ts";
import { isHumanReviewPhase } from "../../helper/is-human-review-phase.ts";
import { completeHumanReviewStep } from "../../../review-diff/steps/05-complete-human-review.ts";

/// loop 内 human_gate の decision 回答値から loop 判定への写像＋4分岐（単一利用のため
/// decideGateRework・gateDecisionValue をインライン化済み。index.test.ts が当該 step の
/// check ソースに "judgeGateRework" を要求するため本関数は残留）。
/// choice_with_input 回答は `{ value, input? }`、single_choice 回答は文字列。
/// 未回答（ゲート skip 時など）は missing → error。
function judgeGateRework(
  value: string | undefined,
  opts: { gateKey: string; loopKey: string; headKey: string },
): CheckResult {
  const decision =
    value === undefined
      ? "missing"
      : value === "approve"
        ? "pass"
        : value === "request_changes"
          ? "continue"
          : value === "abort"
            ? "abort"
            : "unknown";
  if (decision === "missing") {
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} が実行されましたが gateAnswers に回答がありません。ゲート未 confirmed のまま判定ステップへ進んでいます`,
      ],
    };
  }
  if (decision === "pass") {
    return { status: "pass", reasons: [`${opts.gateKey} approved — proceed`] };
  }
  if (decision === "abort") {
    // 中断は値語彙の想定外ではない（正規選択肢）。未知値 fail に混ぜると中断意図が
    // 語彙エラーにすり替わるため、専用の error で分離する。CheckResult に abort 値は
    // 無いため、error で中断意図を記録して止める（round 前進・巻き戻しなし）。
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません。difit セッションの後始末が必要な場合は \`mt difit done\`（冪等・exit 0）を手動実行してください`,
      ],
    };
  }
  if (decision === "unknown") {
    return {
      status: "fail",
      reasons: [
        `${opts.gateKey} の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は新エンジン契約で撤去済みのため request_changes を使ってください。互換受理はしない）`,
      ],
    };
  }
  return {
    status: "continue",
    reasons: [`${opts.gateKey} request_changes — rewind ${opts.loopKey} to ${opts.headKey}`],
  };
}

// -------------------------------------------------------------------
// Step 9: 人間差し戻し判定（plan-run 所有・人間 loop 末尾）
//         await-human-review の gateAnswers を読んで分岐する loop の check。
//         request_changes → 判定 `continue` で人間 loop 先頭（= 自律ループ）へ
//         巻き戻る（範囲内の自律ループの反復状態は初期化される）。
//         round は人間 loop の反復に写像しないため前進させない。
//         approve のときだけ最新 difit 検証・後始末へ進む。
// -------------------------------------------------------------------
export const judgeHumanStep: TaskStepDef = {
  key: "judge-human",
  phase: "人間差し戻し判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    readonly: false,
    buildPrompt: (ctx: PromptCtx) =>
      buildStepPrompt({
        purpose: [
          "await-human-review の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
        ],
        criteria: [],
        approach: [
          "- 状態を変更しない（read-only）。ファイルの作成・編集、`mt difit` コマンドの実行をしない",
          "- report のみ行う。check が承認時の最新未解決 must=0 を確認し、その後に difit を後始末する。差し戻し時はセッションを保持する。",
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    // await-human-review の condition（is-human-review-phase と共有）は findings 不正時に
    // gate を提示せず false を返す。check は自律段階の異常を人間レビューにすり替えないよう
    // findings を再検証し、不正時は gateAnswers を読まず error を返す（分岐の分離）。
    const findingsRaw =
      findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
    const findingsResult = validateFindingsJson(findingsRaw);
    if (!findingsResult.valid || !findingsResult.parsed) {
      return {
        status: "error",
        reasons: [
          `findings.json を検証できないため人間レビュー提示にしない（自律段階の異常を人間レビューにすり替えない）: ${findingsResult.error ?? "invalid findings"}`,
        ],
      };
    }
    // 人間レビュー前の状態を完了扱いにしない。
    if (!isHumanReviewPhase(ctx)) {
      return {
        status: "error",
        reasons: ["人間レビューへの引き渡し条件を満たしていません"],
      };
    }
    // NOTE(ai-1): `questionKey = "decision"` 固定の未検証前提にしない。指定キー不在時は
    // 全設問キーを走査する（decision 優先・request_changes > abort > approve の順で
    // fail-closed に1値を選ぶ最小限の走査。def 参照による動的解決はしない）。
    const gateValue: string | undefined = (() => {
      const stepKey = "await-human-review";
      const questionKey = "decision";
      const perGate = ctx.gateAnswers[stepKey];
      if (!perGate) return undefined;
      const direct = perGate[questionKey];
      if (direct !== undefined) {
        // 指定キー present 時の契約外形状は他キー走査で糊塗せず undefined（→error）にする。
        return gateAnswerValue(direct);
      }
      const values = new Set<string>();
      for (const ans of Object.values(perGate)) {
        const value = gateAnswerValue(ans);
        if (value === undefined) continue;
        values.add(value);
      }
      // 差し戻し（request_changes）の見落としが最も危険なため優先し、次に中断意図
      // （abort）、承認（approve）の順。未知値は決定的に1つ選ぶ（Set 挿入順の先頭）。
      for (const priority of ["request_changes", "abort", "approve"]) {
        if (values.has(priority)) return priority;
      }
      return values.values().next().value as string | undefined;
    })();
    const decision = judgeGateRework(gateValue, {
      gateKey: "await-human-review",
      loopKey: "human-review-cycle",
      headKey: "autonomous-review-cycle",
    });
    return decision.status === "pass" ? completeHumanReviewStep.check(ctx) : decision;
  },
};
