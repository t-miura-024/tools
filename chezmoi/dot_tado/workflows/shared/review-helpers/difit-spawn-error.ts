/// `mt difit` の実行ファイルを起動できなかった（ENOENT / EACCES 等）ことを表すエラー。
/// 空 stdout / stderr の正常戻りとして扱うと、呼び出し元が「difit セッション不在」や
/// 「ゲート出力なし」と誤診し、実際の原因（PATH 破損・mt 不在）が CheckResult の理由から
/// 消えるため、専用エラーで原因を届ける。
export class DifitSpawnError extends Error {
  constructor(args: string[], cause: unknown) {
    const code = (cause as { code?: unknown } | null)?.code;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `mt difit ${args.join(" ")} を起動できませんでした（spawn 失敗${typeof code === "string" ? `: ${code}` : ""}）: ${detail}。mt が PATH に無い・実行権限が無い等の環境要因を確認してください`,
    );
    this.name = "DifitSpawnError";
  }
}
