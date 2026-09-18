import type { ArtifactRecord, CheckCtx } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { parseJson } from "../../shared/review-helpers/parse-json";
import { isRecord } from "../../shared/review-helpers/is-record";
import { expectedDifitSelection } from "../../shared/review-helpers/expected-difit-selection";
import { validateDifitSelection } from "../../shared/review-helpers/validate-difit-selection";
import { resolveEffectiveEffortBase } from "../../shared/review-helpers/resolve-effective-effort-base";
import { readDifitReviewState } from "../../shared/review-helpers/read-difit-review-state";
import { EFFORT_KEY } from "../../shared/review-helpers/effort-key";
import { describeRecoveryCommand } from "./describe-recovery-command.ts";
/// effort.json の base/target と `.difit/difit-review.json` の selection（選択固定キー）の
/// 整合を検証し、不一致・検証不能の理由を返す（一致なら空配列）。
///
/// start-difit-review（起動時）と collect-verdict（ゲート時）が同じ写像
/// （expectedDifitSelection + validateDifitSelection）を使う。起動検証の通過後に
/// state.selection を別の選択（空セッション等）へ書き換え、ゲートの threads / dry-run に
/// 偽の通過を返させる TOCTOU を、通過・後始末の直前の再照合で検出する。
export function difitSelectionReasons(ctx: CheckCtx): string[] {
  const effortRaw =
    findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, EFFORT_KEY);
  const effort = parseJson(effortRaw);
  if (!isRecord(effort)) {
    return [
      `${EFFORT_KEY} が見つからないか JSON オブジェクトではありません。base/target と difit 選択の整合を検証できないため fail とします`,
    ];
  }
  const effortTarget =
    typeof effort.target === "string" && effort.target.trim() ? effort.target.trim() : undefined;
  const expectation = expectedDifitSelection(resolveEffectiveEffortBase(effort.base), effortTarget);
  if ("error" in expectation) {
    return [expectation.error];
  }
  const stateRead = readDifitReviewState();
  if ("error" in stateRead) {
    return [
      `.difit/difit-review.json を読み取れません: ${stateRead.error}。選択状態を検証できないため fail とします`,
    ];
  }
  if ("missing" in stateRead) {
    return [
      "difit セッションが見つかりません（.difit/difit-review.json 不在）。選択状態を検証できないため fail とします",
    ];
  }
  const selectionError = validateDifitSelection(stateRead.state.selection, expectation.expected);
  if (!selectionError) return [];
  return [
    selectionError,
    effortTarget
      ? `target ありの起動（復旧）は ${describeRecoveryCommand(ctx)}（difit の第2引数が compare-with=base）です。base 単独の起動では target の範囲が提示されません`
      : `起動は ${describeRecoveryCommand(ctx)} です。effort.json に target がある場合は target も提示する起動に切り替えてください`,
    "base/target の ref が起動後に動いた場合（merge-base が変化した場合）は、`mt difit done` でセッションを終了してから start し直し、diff.txt と同じ範囲の選択を作り直してください",
  ];
}
