import { DIFIT_MAX_BUFFER_BYTES } from "./difit-max-buffer-bytes.ts";

/// `mt difit` の stdout が `DIFIT_MAX_BUFFER_BYTES` を超えたことを表すエラー。
/// 切り詰められた stdout をパース失敗として扱わず、原因（出力サイズ超過）を
/// CheckResult の理由へ届けるために使う。
export class DifitOutputTooLargeError extends Error {
  constructor(args: string[]) {
    super(
      `mt difit ${args.join(" ")} の stdout が maxBuffer (${DIFIT_MAX_BUFFER_BYTES} bytes = ${DIFIT_MAX_BUFFER_BYTES / 1024 / 1024} MiB) を超えました。レビュー対象または未 resolve スレッドが多すぎるため出力を取得できません`,
    );
    this.name = "DifitOutputTooLargeError";
  }
}
