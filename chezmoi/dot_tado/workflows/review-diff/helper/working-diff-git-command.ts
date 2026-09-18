/// target なし収集の git コマンド。`$BASE` を merge-base(HEAD, base) に解決し、
/// merge-base..ワーキングツリー（committed + staged + unstaged）を 1 コマンドで収集する。
/// difit の `.` 提示（内部は `git diff <merge-base>`）と同一範囲で、index に載った
/// staged 変更を落とさない。契約テストが実 Git リポジトリでこの文字列を実行し、
/// staged 変更・staged 新規ファイルが diff.txt に現れることを固定する
/// （prompt と check の写像ドリフト防止）。
export const WORKING_DIFF_GIT_COMMAND =
  'git -c core.quotePath=false diff "$(git merge-base HEAD "$BASE")"';
