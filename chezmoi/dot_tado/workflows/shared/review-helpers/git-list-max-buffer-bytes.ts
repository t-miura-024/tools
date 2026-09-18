/// git 一覧系出力（ls-files / status / numstat）の上限。大量の変更ファイルでも
/// 切り詰めず、取得失敗（原因不明の打ち切り）と区別する。
export const GIT_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
