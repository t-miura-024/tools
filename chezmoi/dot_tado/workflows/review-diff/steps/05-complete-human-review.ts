import type { CheckCtx, CheckResult } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { fetchDifitThreads } from "../../shared/review-helpers/fetch-difit-threads";
import { requireDifitSelectionDrift } from "../../shared/review-helpers/require-difit-selection-drift";
import { describeDifitSelectionDrift } from "../../shared/review-helpers/describe-difit-selection-drift";
import { cleanupDifitSession } from "../../shared/review-helpers/cleanup-difit-session";
import { difitSelectionReasons } from "../helper/difit-selection-reasons.ts";
/// 人間承認後の最新状態を検証して終了する。findings のスナップショットで再レビューしない。
export const completeHumanReviewStep: TaskStepDef = {
  key: "complete-human-review",
  phase: "人間承認の検証",
  type: "task",
  maxRetries: 0,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: () => "人間承認後、check が difit の最新未解決 must を確認して後始末する。",
  },
  check: (ctx: CheckCtx): CheckResult => {
    const selectionReasons = difitSelectionReasons(ctx);
    if (selectionReasons.length > 0) return { status: "fail", reasons: selectionReasons };
    const { output, stderr } = fetchDifitThreads();
    if (!output)
      return { status: "error", reasons: ["difit の最新スレッドを取得できません", stderr] };
    const drift = requireDifitSelectionDrift(output);
    if ("violation" in drift) return { status: "fail", reasons: [drift.violation] };
    if (drift.drift.detection !== "none") {
      return { status: "fail", reasons: [describeDifitSelectionDrift(drift.drift)] };
    }
    const must = output.threads.filter((thread) => thread.taxonomy === "issue");
    if (must.length > 0) {
      return {
        status: "fail",
        reasons: [
          `未解決 must=${must.length}。修正結果を人間が確認し、difit 上の must をすべて解決してから承認してください。未修正受容・別Issue引き継ぎでは完了できません`,
        ],
      };
    }
    const cleanup = cleanupDifitSession();
    if (cleanup.status === "error") return { status: "error", reasons: cleanup.reasons };
    // done の stdout は done 実行時点のゲート結果であり、passes=false が即 後始末失敗では
    // ない（DifitSessionCleanup.done の契約）。ただし「非通過なのに blocking_threads が空」は
    // ゲート結果を取得できていない出力（判定不能。単独 collect-verdict の done 消費と同じ
    // 解釈）であり、このまま通すと直前の threads 突合（must=0）の効力が done 時点で無音に
    // 失われる。新規の検知機構は設けず、既存出力契約の消費として fail-closed で止める。
    const done = cleanup.done!;
    const doneMust = done.blocking_threads.filter((thread) => thread.taxonomy === "issue").length;
    if (doneMust > 0 || (!done.passes && done.blocking_threads.length === 0)) {
      return {
        status: "fail",
        reasons: [
          doneMust > 0
            ? `後始末時点で未解決 must=${doneMust} が確認されました。完了できません`
            : "`mt difit done` が非通過 (passes=false) かつ blocking_threads 空（ゲート結果を取得できていない出力）を返しました。done 時点の must=0 を検証できないため完了できません",
        ],
      };
    }
    return {
      status: "pass",
      reasons: ["人間承認済み・未解決 must=0。difit 後始末完了", ...cleanup.stderr],
    };
  },
};
