import type { CheckCtx } from "tado";
import type { VerdictJson } from "../../shared/review-helpers/types";
import { join } from "node:path";
import fs from "node:fs";
import { runDifitCommand } from "../../shared/review-helpers/run-difit-command";
import { difitCommandFailureMessage } from "../../shared/review-helpers/difit-command-failure-message";
import { parseDifitCheck } from "../../shared/review-helpers/parse-difit-check";
import { difitStderrReasons } from "../../shared/review-helpers/difit-stderr-reasons";
import { requireDifitSelectionDrift } from "../../shared/review-helpers/require-difit-selection-drift";
import { describeDifitSelectionDrift } from "../../shared/review-helpers/describe-difit-selection-drift";
import { canonicalizeDifitThreads } from "../../shared/review-helpers/canonicalize-difit-threads";
import { DIFIT_CHECK_KEY } from "../../shared/review-helpers/difit-check-key";
import type { DifitCheckOutput, DifitCommandResult } from "../../shared/review-helpers/types";
import type { DifitDryRunDriftProblem, DifitDryRunVerification } from "../types.ts";

/// collect-verdict の check が両経路（round limit 経路 / 通常経路）で共有する
/// dry-run 検証パイプライン（結果の型は ../types.ts の DifitDryRunVerification）。
/// 経路ごとの非対称は戻り値の扱い（マッピング）にだけ現れる（詳細は型の doc を参照）。
export function verifyDifitDryRun(
  ctx: CheckCtx,
  verdict: VerdictJson,
  selectionReasons: string[],
): DifitDryRunVerification {
  let dryRun: DifitCommandResult;
  try {
    dryRun = runDifitCommand(["check", "--dry-run"]);
  } catch (error) {
    const failure = difitCommandFailureMessage(error);
    if (failure === undefined) throw error;
    return { kind: "command-error", reasons: [failure] };
  }
  const stderr = difitStderrReasons(dryRun.stderr);
  const daemon = parseDifitCheck(dryRun.stdout);
  if (!daemon) {
    return { kind: "no-gate-output", stderr };
  }

  // daemon 出力は突合の一致・不一致にかかわらず永続化する。不一致で execute_work に
  // ループしても executor が最新の blocking 一覧を読める（永続化はセッションを消費しない）。
  try {
    fs.writeFileSync(
      join(ctx.sessionDir, DIFIT_CHECK_KEY),
      `${JSON.stringify(daemon, null, 2)}\n`,
      "utf-8",
    );
  } catch (error) {
    return {
      kind: "persist-error",
      reasons: [`failed to persist difit check output: ${String(error)}`],
    };
  }

  // 選択ドリフト（detected）と契約違反（フィールド欠落・解釈不能）、probe 失敗
  // （unavailable = 検知不能）は「ドリフトなし」と混同せず fail-closed で扱う。
  const issues: string[] = [];
  let drift: DifitDryRunDriftProblem | undefined;
  const driftCheck = requireDifitSelectionDrift(daemon);
  if ("violation" in driftCheck) {
    drift = { type: "violation", description: driftCheck.violation };
    issues.push(
      `${driftCheck.violation}。上限判定時点のゲート状態（passes / blocking_threads）を検証できていません`,
    );
  } else if (driftCheck.drift.detection !== "none") {
    const description = describeDifitSelectionDrift(driftCheck.drift);
    drift = {
      type: driftCheck.drift.detection === "detected" ? "detected" : "undetectable",
      description,
    };
    issues.push(
      `${description}。上限判定時点のゲート状態（passes / blocking_threads）を検証できていません`,
    );
  }
  if (selectionReasons.length > 0) {
    // start-difit-review 通過後に state.selection が effort.json の base/target と
    // 乖離した（TOCTOU）。dry-run の pass / blocking 一致を「選択を検証済みの突合」
    // として扱わない。
    issues.push(
      "ゲート前提（提示範囲 = 検証対象）の再検証に失敗しました: state.selection が effort.json の base/target と一致しません",
      ...selectionReasons,
    );
  }

  const reported: DifitCheckOutput = {
    passes: verdict.passed,
    blocking_threads: verdict.blocking_threads,
  };
  return {
    kind: "ok",
    daemon,
    matched:
      daemon.passes === reported.passes &&
      canonicalizeDifitThreads(daemon.blocking_threads) ===
        canonicalizeDifitThreads(reported.blocking_threads),
    selectionVerified: drift === undefined && selectionReasons.length === 0,
    issues,
    ...(drift ? { drift } : {}),
    stderr,
  };
}
