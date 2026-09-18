import type { DifitCommandResult, DifitSessionCleanup } from "./types.ts";
import { difitCommandFailureMessage } from "./difit-command-failure-message.ts";
import { difitStderrReasons } from "./difit-stderr-reasons.ts";
import { isProcessAlive } from "./is-process-alive.ts";
import { parseDifitCheck } from "./parse-difit-check.ts";
import { readDifitReviewState } from "./read-difit-review-state.ts";
import { runDifitCommand } from "./run-difit-command.ts";

/// difit セッションの後始末（`mt difit done` の実行と実効性検証）を 1 箇所に集約する。
///
/// 手順:
///   1. done の前に state を読み、記録 pid を控える（生存していれば done 後に orphan として検出する）
///   2. `mt difit done`（冪等・exit 0）を実行し、stdout のゲート出力契約を検証する
///   3. `.difit/difit-review.json` の消失を検証する（読み取り不能は『削除済み』と断定しない）
///   4. done 前に控えた pid が終了していることを検証する
///
/// collect_verdict（通過時の後始末）と plan-run の release_difit_session（受容時の後始末）が
/// 同一の検証規則を使う（片側だけ pid 検証が弱い、という非対称を作らない）。
/// 呼び出し元は done を先行実行しないこと（先行実行すると pid を控えられず検証が弱くなる）。
export function cleanupDifitSession(): DifitSessionCleanup {
  const beforeRead = readDifitReviewState();
  const pidBeforeDone = "state" in beforeRead ? beforeRead.state.pid : undefined;

  let doneResult: DifitCommandResult;
  try {
    doneResult = runDifitCommand(["done"]);
  } catch (error) {
    // 振り分けは difitCommandFailureMessage に集約（呼び出し元ごとの扱いは同関数の doc）。
    const failure = difitCommandFailureMessage(error);
    if (failure === undefined) throw error;
    return { status: "error", reasons: [failure], stderr: [] };
  }
  const stderr = difitStderrReasons(doneResult.stderr);
  const done = parseDifitCheck(doneResult.stdout);
  if (!done) {
    return {
      status: "error",
      reasons: [
        "`mt difit done` が後始末出力 (passes / blocking_threads の JSON) を返しませんでした。difit セッションが残っている可能性があります",
        ...stderr,
      ],
      stderr,
    };
  }

  // 後始末の実効性を state 消失まで確認する（削除失敗の検出）。
  // 読み取り不能（EACCES / EISDIR / 競合）は「削除済み」と断定せず error にする。
  const remainingRead = readDifitReviewState();
  if ("error" in remainingRead) {
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 後の .difit/difit-review.json を読み取れません (${remainingRead.error})。後始末の完了を検証できないため error とします`,
      ],
      stderr,
    };
  }
  if ("state" in remainingRead) {
    const remaining = remainingRead.state;
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 実行後も .difit/difit-review.json が残っています (port=${remaining.port}, pid=${remaining.pid})。後始末が完了していません`,
      ],
      stderr,
    };
  }
  // state 削除に加えて、記録 pid が終了していることまで確認する
  // （kill が同一性未確認でスキップされた orphan の検出）。
  if (pidBeforeDone !== undefined && isProcessAlive(pidBeforeDone)) {
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 実行後も difit プロセス (pid=${pidBeforeDone}) が生存しています。後始末が完了しておらず、orphan プロセスが残っている可能性があります。\`mt difit status\` で確認してください`,
      ],
      stderr,
    };
  }

  return {
    status: "pass",
    reasons: [
      pidBeforeDone === undefined
        ? "difit session released (state removed)"
        : `difit session released (state removed, pid=${pidBeforeDone} exited)`,
    ],
    done,
    stderr,
  };
}
