import type { WorkflowDef } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { effortLoopStep } from "./steps/01-effort-loop/index.ts";
import { effortExhaustedGateStep } from "./steps/02-effort-exhausted-gate.ts";
import { humanReviewLoopStep } from "./steps/03-human-review-loop/index.ts";
import { humanExhaustedGateStep } from "./steps/04-human-exhausted-gate.ts";
import { createCollectVerdictStep } from "./helper/create-collect-verdict-step.ts";

// =============================================================================
// Human gate loop 置換（revise 撤去後の巻き戻し）
// ----------------------------------------------------------------------------
// tado エンジンの humanGate.reviseTargetStep / revise 選択は撤去済み
// （新エンジン契約。互換シムなし・旧 revise 値は受理しない）。
// 履歴調査: `git log -S reviseTargetStep` で review-diff に reviseTargetStep の
// 記録は見つからなかった（revise 契約自体がエンジン側で撤去され、本WFに残留なし）。
// そのため各ゲートの loop 始点は観測振る舞いと同等になるよう以下に据える:
//   - resolve-effort（先頭ゲート。巻き戻し先は自身）:
//     effort-loop body = [resolve-effort, collect-context, judge-effort]。
//     先頭 worker（collect-context）が request_changes 入力を effort.json 生成に反映する。
//   - await-human-review（difit 提示の確認）:
//     human-review-loop body =
//     [verify-fix, run-reviewers, normalize-findings, start-difit-review,
//      await-human-review, collect-verdict, judge-human-review]。
//     差し戻し時は先頭 worker（verify-fix）が修正有無・回帰テスト存在を確認してから、
//     run-reviewers が白紙・同一テンプレートで再反証する（依頼文による収束の防止）。
//     先頭 worker（verify-fix）は request_changes 入力を修正確認にのみ使い、
//     run-reviewers の検証者プロンプトへ重点付け・混入させない。
// 共通設計:
//   - loop は maxIterations=3・onExhausted=escalate。
//   - judge（末尾 task の check）が gateAnswers を読む唯一の分岐点:
//     approve→pass（脱出）、request_changes→continue（先頭へ巻き戻り）、
//     abort→error（中断意図の記録。巻き戻しなし）、未知値→fail（旧 revise 含む）、
//     未回答→error（fail-closed）。
//   - loop 外の枯渇ゲート（effort-exhausted-gate / human-exhausted-gate）は
//     approve/abort のみ（request_changes なし。loop 外 continue は fail-fast のため）。
//     condition が loop 内ゲートの request_changes のときだけ true
//     （枯渇時のみ提示。常時提示しない）。
//   - stale 世代管理: judge は自 loop のゲートキーのみ読む。
//     先頭 worker の差し戻し注入は gateKey のみで解決する（ctx.loop.key には依存しない）。
//     plan-run が Step を spread して自 loop へ配置しても、loop key 不一致で
//     「なし」へ潰さず修正理由を届ける（ghost loss の防止）。
//     役割分担: この直接注入は再レビュー context 用であり、plan-run の
//     apply_feedback → feedback.json → execute_work（コード修正指示）とは別経路。
//     同一 prompt 内での二重載せはしない。各 worker は自ゲートのみ読む
//     （collect-context=resolve-effort、run-reviewers=await-human-review）。
//     plan-run 側の世代管理（skip ゲートの stale 除外）は plan-run の
//     GATE_SKIP_CONDITIONS / isHumanReviewPhase が担い、apply_feedback /
//     execute_work / judge が同一写像で除外する。直接注入と feedback.json 統合は
//     別 consumer（再レビュー参照 / executor 修正指示）への fan-out であり、
//     同一 artifact への二重書き込みではない。
// =============================================================================

const def: WorkflowDef = {
  id: "review-diff",
  description:
    "差分を敵対的に検証するワークフロー。width×depth の effort で 15 観点プールから検証者を割り当て、difit 方式で指摘を提示し verdict まで完結する。",

  steps: [effortLoopStep, effortExhaustedGateStep, humanReviewLoopStep, humanExhaustedGateStep],
};

export default def;

export { effortExhaustedGateStep, humanExhaustedGateStep };
export { resolveEffortStep } from "./steps/01-effort-loop/01.01-resolve-effort.ts";
export { collectContextStep } from "./steps/01-effort-loop/01.02-collect-context.ts";
export { judgeEffortStep } from "./steps/01-effort-loop/01.03-judge-effort.ts";
export { verifyFixStep } from "./steps/03-human-review-loop/03.01-verify-fix.ts";
export { runReviewersStep } from "./steps/03-human-review-loop/03.02-run-reviewers.ts";
export { normalizeFindingsStep } from "./steps/03-human-review-loop/03.03-normalize-findings.ts";
export { startDifitReviewStep } from "./steps/03-human-review-loop/03.04-start-difit-review.ts";
export { awaitHumanReviewStep } from "./steps/03-human-review-loop/03.05-await-human-review.ts";
export { collectVerdictStep } from "./steps/03-human-review-loop/03.06-collect-verdict.ts";
export { judgeHumanReviewStep } from "./steps/03-human-review-loop/03.07-judge-human-review.ts";
export { completeHumanReviewStep } from "./steps/05-complete-human-review.ts";
export { WORKING_DIFF_GIT_COMMAND } from "./helper/working-diff-git-command.ts";
export { TARGET_RANGE_GIT_COMMAND } from "./helper/target-range-git-command.ts";

/// plan-run の自律レビュー用。検証・指摘収集は単独版と共有し、上限判定と終了は消費者が所有する。
export const collectAutonomousVerdictStep: TaskStepDef = createCollectVerdictStep(true);
