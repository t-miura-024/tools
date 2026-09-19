import { spawnSync } from "node:child_process";
import type { DifitCommandResult } from "./types.ts";
import { DIFIT_COMMAND_TIMEOUT_MS } from "./difit-command-timeout-ms.ts";
import { DIFIT_MAX_BUFFER_BYTES } from "./difit-max-buffer-bytes.ts";
import { DifitOutputTooLargeError } from "./difit-output-too-large-error.ts";
import { DifitSpawnError } from "./difit-spawn-error.ts";
import { DifitTimeoutError } from "./difit-timeout-error.ts";
import { isMaxBufferOverflow } from "./is-max-buffer-overflow.ts";
import { isTimeoutFailure } from "./is-timeout-failure.ts";
import { outputText } from "./output-text.ts";

/// mt difit サブコマンドを実行して stdout / stderr を回収して返す。
/// exit 1 はゲートブロックなど正常系の出力を伴うため、throw せず stdout を回収する。
/// stderr は選択ドリフト警告・同一性照合エラー等の診断情報を含むため捨てずに返し、
/// 呼び出し元が CheckResult の理由 / executor フィードバックへ流せるようにする。
/// stdout が maxBuffer を超えた場合は切り詰められた stdout を返さず
/// `DifitOutputTooLargeError` を投げる（パース失敗で原因を覆い隠さない）。
/// timeoutMs 以内に応答しない場合は child を kill して `DifitTimeoutError` を投げる
/// （同期実行で workflow が無制限にブロックしない）。
/// 実行ファイルを起動できない場合（ENOENT / EACCES 等）は空出力を返さず
/// `DifitSpawnError` を投げ、原因を CheckResult の理由へ届ける。
export function runDifitCommand(
  args: string[],
  timeoutMs = DIFIT_COMMAND_TIMEOUT_MS,
): DifitCommandResult {
  const result = spawnSync("mt", ["difit", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: DIFIT_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    // bun は process.env への代入を実行パス解決に反映しないため、
    // テストの PATH 差し替えが効くよう明示的に現在の env を渡す
    env: { ...process.env },
  });
  if (isMaxBufferOverflow(result.error)) throw new DifitOutputTooLargeError(args);
  if (isTimeoutFailure(result.error)) throw new DifitTimeoutError(args);
  if (result.error) throw new DifitSpawnError(args, result.error);
  return {
    stdout: outputText(result.stdout),
    stderr: outputText(result.stderr),
  };
}
