import { isDifitOutputTooLargeError } from "./is-difit-output-too-large-error.ts";
import { isDifitSpawnError } from "./is-difit-spawn-error.ts";
import { isDifitTimeoutError } from "./is-difit-timeout-error.ts";

/// difit コマンド実行が投げる失敗（DifitOutputTooLargeError / DifitTimeoutError /
/// DifitSpawnError）を CheckResult / 後始末の理由メッセージへ変換する。
/// 対象外の例外は undefined を返し、呼び出し元が rethrow する。
///
/// 扱いを分けている呼び出し元（3 エラー型の追加・変更はこの関数だけを直す）:
///   1. cleanupDifitSession（本ファイル） — メッセージを `status: "error"` の理由にする
///   2. start_difit_review の check（review-diff/index.ts） — メッセージを
///      `status: "fail"` の理由にする
///   3. collect_verdict の check（同） — verifyDifitDryRun 経由。round limit 経路は
///      メッセージを理由に残して人間判断（human_gate）へ継続し、通常経路は
///      `status: "error"` の理由にする
export function difitCommandFailureMessage(error: unknown): string | undefined {
  if (isDifitOutputTooLargeError(error) || isDifitTimeoutError(error) || isDifitSpawnError(error)) {
    return error.message;
  }
  return undefined;
}
