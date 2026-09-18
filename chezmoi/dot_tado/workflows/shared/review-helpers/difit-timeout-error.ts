import { DIFIT_COMMAND_TIMEOUT_MS } from "./difit-command-timeout-ms.ts";

/// `mt difit` の stdout / stderr が `DIFIT_COMMAND_TIMEOUT_MS` 内に得られなかったことを表すエラー。
/// spawnSync の timeouts は child を kill しても result.error.code=ETIMEDOUT を返すため、
/// 切り詰められた stdout / stderr を契約出力として扱わず、原因（時間超過）を
/// CheckResult の理由へ届けるために使う。
export class DifitTimeoutError extends Error {
  constructor(args: string[]) {
    super(
      `mt difit ${args.join(" ")} が ${DIFIT_COMMAND_TIMEOUT_MS / 1000} 秒以内に応答しませんでした（timeout）。difit サーバが応答していないか、mt difit done の stale 復旧が長時間化しています`,
    );
    this.name = "DifitTimeoutError";
  }
}
