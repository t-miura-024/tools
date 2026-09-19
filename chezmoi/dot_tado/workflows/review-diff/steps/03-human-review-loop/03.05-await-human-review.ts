import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { FINDINGS_KEY } from "../../../shared/review-helpers/findings-key";
import { DIFIT_START_KEY } from "../../../shared/review-helpers/difit-start-key";
import { DIFIT_COMMENTS_KEY } from "../../../shared/review-helpers/difit-comments-key";
import { DIFIT_RECOVERY_BASE_COMMAND } from "../../helper/difit-recovery-base-command.ts";
import { TARGET_RECOVERY_NOTE } from "../../helper/target-recovery-note.ts";
export const awaitHumanReviewStep: HumanGateStepDef = {
  key: "await-human-review",
  phase: "人間レビュー待機",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  // review-diff 単独実行では must 件数によらず人間レビューを必ず提示する
  // （condition なし）。must>0 の自律段階で skip する 2段階ループはループ所有者
  // （plan-run）が condition を override して行う。
  // ゲート通過検証は collect-verdict の `mt difit check --dry-run` 突合に一本化する。
  // 現行 tado 0.1.0 は human_gate の check を実行しない（check が呼ばれるのは task の
  // report 経路のみで、human_gate の回答は confirm が回答を記録するだけ）ため、
  // StepDef 型を満たすための no-op のみ置く。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: [FINDINGS_KEY, DIFIT_START_KEY, DIFIT_COMMENTS_KEY],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          `difit-start.json の url（mt difit start が提示した http://localhost:<port>）をブラウザで開き、未 resolve スレッドを確認する。UI のリビジョンセレクタを切り替えていた場合は、起動時の選択（レビュー開始時の base/target）へ戻してから reply / resolve すること（\`mt difit check --dry-run\` / \`mt difit threads --json\` の \`selection_drift.detection\` が \`detected\` ならドリフト中、\`unavailable\` なら probe 失敗＝検知不能。どちらも検証ステップが fail-closed で扱い、通過できない。セレクタを戻さないと reply / resolve はゲートが読まない別セッションへ書き込まれる）。url のページを確認できないまま approve しないこと。\`selection_drift.detection\` が \`unavailable\` の場合は \`${DIFIT_RECOVERY_BASE_COMMAND}\` でセッションを復旧する。` +
          TARGET_RECOVERY_NOTE,
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "レビュー完了",
            desc:
              `difit-start.json の url をブラウザで開き、指摘の確認・reply・resolve を終え、verdict 判定へ進む。UI のリビジョンセレクタは起動時の選択へ戻してから reply / resolve する（ドリフトしたままの操作はゲートが読まない別セッションへ書き込まれる）。\`selection_drift.detection\` が \`unavailable\`（検知不能）の場合は \`${DIFIT_RECOVERY_BASE_COMMAND}\` でセッションを復旧し、選択を確認できるまで approve しないこと。` +
              TARGET_RECOVERY_NOTE,
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "修正する",
            desc: "レビュー指摘を修正する",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
};
