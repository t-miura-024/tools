# mt CLI

個人用 CLI ツール群。Git / chezmoi / ツール管理 / ベクトル検索 / difit レビュー等のサブコマンドを持つ。

## Language

**review session**:
`mt difit start` で始まり `mt difit check` exit 0 で終わる、1 つの difit サーバライフサイクル。
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
