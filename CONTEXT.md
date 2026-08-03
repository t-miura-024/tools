# mt CLI

個人用 CLI ツール群。Git / chezmoi / ツール管理 / ベクトル検索 / difit レビュー等のサブコマンドを持つ。

## Language

**review session**:
`mt difit start` で始まり `mt difit check` または `mt difit done` で終わる、1 つの difit サーバライフサイクル。
_Avoid_: review, difit session

**gate**:
`mt difit check` による通過/ブロック判定。exit 0 = 通過、exit 1 = ブロック。
_Avoid_: check, validation

**taxonomy**:
コメントの分類プレフィックス。`[issue]`（AI 発見の問題点）、`[question]`（AI が人間に判断を仰ぐ）、`[context]`（人間向け解説）、プレフィックスなし（人間のコメント）。
_Avoid_: category, label, type

**thread**:
difit のコメントスレッド（親メッセージ + reply 群）。ゲート判定はスレッド親の body で行う。
_Avoid_: comment, conversation

**stale state**:
`difit-review.json` が存在するがサーバプロセスが死んでいる状態。`start` / `check` が自己修復する。
_Avoid_: orphan, zombie

**contextNotes**:
executor SubAgent が実装判断根拠やレビュー補足を `[context]` として残す構造化データ。difit import スキーマ準拠（`{filePath, position?, body}`）。
_Avoid_: notes, remarks, annotations

**選択キー**:
difit がコメントセッションを識別するためのキー。baseCommitish + targetCommitish + baseMode の組み合わせ。
_Avoid_: session key, diff key

**commentImports**:
difit サーバーが /api/diff レスポンスに含める起動時コメント。選択キーが一致する場合のみ配信される。
_Avoid_: imported comments, initial comments

**merge-base 解決**:
git merge-base <base> HEAD でベースコミットを解決し、3-way diff を行うモード。
_Avoid_: merge base mode, three-way mode
