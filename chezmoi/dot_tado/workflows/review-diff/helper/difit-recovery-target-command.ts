/// difit 復旧コマンドの案内（target あり）。target ありの起動は difit の第2引数が
/// compare-with=base であり、単独 base で起動し直すと提示範囲が base...target から外れる。
export const DIFIT_RECOVERY_TARGET_COMMAND = "mt difit start <target> <base-branch> --merge-base";
