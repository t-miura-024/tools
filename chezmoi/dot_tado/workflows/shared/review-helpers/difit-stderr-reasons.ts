/// `mt difit` の stderr を CheckResult の理由行へ整形する（空なら空配列）。
/// 選択ドリフト警告や同一性照合エラーを握りつぶさず人間・executor へ届ける。
export function difitStderrReasons(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `mt difit stderr: ${line}`);
}
