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

**repo エントリ**:
`bun-global.yml` で GitHub ホストパッケージを宣言する `repo:` フィールド持ちのエントリ。`repo: <owner>/<name>` はデフォルトブランチ最新への追従を意味する。
_Avoid_: git エントリ, GitHub パッケージエントリ

**version エントリ**:
`bun-global.yml` で registry パッケージを宣言する `version:` フィールド持ちのエントリ。repo エントリと相互排他。
_Avoid_: npm エントリ, registry エントリ

**ファイルレベル指摘**:
position を持たない thread。ファイル全体に紐づく指摘・補足。difit スキーマに表現がなく、`mt difit start` の position 合成で line:1 に変換される。
_Avoid_: ファイル全体コメント, ファイルスコープ指摘

**position 合成**:
`mt difit start` が position なしの import エントリに `{"side":"new","line":1}` を付与して difit の必須スキーマを満たす動作。
_Avoid_: 正規化, フォールバック

### grilling（mt-grill-rounds）

**round**:
フロンティアの質問をまとめて提示し、ユーザーの回答を待つ 1 往復の単位。
_Avoid_: ターン, イテレーション

**frontier**:
前提条件がすべて確定済みで、今この瞬間に尋ねられる決定の集合。
_Avoid_: キュー, 未回答リスト

**design tree**:
決定事項をノード、依存関係をエッジとして持つ木の構造。ラウンドごとの回答で枝が確定し、フロンティアが外側へ押し出される。
_Avoid_: 質問リスト, アジェンダ
