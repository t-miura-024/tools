/// `mt difit` 呼び出し 1 回あたりの許容時間。workflow の check から spawnSync で
/// 同期実行されるため、difit サーバが accept したまま応答しない場合でも
/// イベントループを塞いだまま無制限にブロックしない上限を設ける。
/// (`mt difit done` は stale 復旧時に保存済みコメントを分割 HTTP POST する
/// ため、チャンク数 × HTTP タイムアウトが理論上ここに達し得る。)
export const DIFIT_COMMAND_TIMEOUT_MS = 120_000;
