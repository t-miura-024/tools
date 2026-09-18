/// target あり収集の git コマンド（`$BASE...$TARGET` = merge-base..target）。
/// `mt difit start "$TARGET" "$BASE" --merge-base` の提示範囲と同一。
export const TARGET_RANGE_GIT_COMMAND = 'git -c core.quotePath=false diff "$BASE...$TARGET"';
