/// `mt difit` stdout の上限。`mt difit threads --json` は未 resolve スレッド全件の
/// 親本文と replies を含み、指摘数・本文長に比例して増える。execFileSync の既定
/// 1 MiB では大規模レビューで切り詰められ「原因不明のパース失敗」になるため、
/// 16 MiB まで許容する。
export const DIFIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
