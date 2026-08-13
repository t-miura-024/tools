# mt CLI

個人用 CLI ツール群。Git / chezmoi / ツール管理 / ベクトル検索 / hunk レビュー等のサブコマンドを持つ。

## Language

**review session**:
`mt hunk start` で始まり `mt hunk check` または `mt hunk done` で終わる、1 つの hunk セッションライフサイクル。
_Avoid_: review, hunk session

**gate**:
`mt hunk check` による通過/ブロック判定。exit 0 = 通過、exit 1 = ブロック。
_Avoid_: check, validation

**taxonomy**:
コメントの分類プレフィックス。`[issue]`（AI 発見の問題点）、`[question]`（AI が人間に判断を仰ぐ）、プレフィックスなし（人間のコメント）。
_Avoid_: category, label, type

**コメント**:
hunk セッション内の行紐づきインラインコメント。AI コメントと人間コメント（user タイプ）がある。ゲート判定は AI コメント（want を除く）と人間コメントの残存で行う。
_Avoid_: annotation, note

**解決**:
人間が AI コメントを hunk の UI で削除（rm）することで、そのコメントを解決済みとみなす動作。ゲートは解決されていない AI コメントと人間コメントの残存で判定する。
_Avoid_: resolve, 対応済み

**want コメント**:
agent-review.json の want 指摘（`[question] (want)` で表示）。ゲートをブロックしない。同一行に人間コメントが付いた場合のみ修正対象となり、無視されても修正しない。
_Avoid_: 任意指摘, suggestion

**stale state**:
`hunk-review.json` が存在するが対応する hunk セッションを検出できない状態。`start` / `check` が自己修復する。
_Avoid_: orphan, zombie

**手動見直し**:
人間が既存の AI エージェント設定（Rule・Skill・SubAgent・Hook）に対して行う削除・内容変更の作業。AI は関与しない。
_Avoid_: 手動操作, 直接編集

**影響範囲確認**:
手動変更を起点に、変更箇所以外の参照・整合性の破綻を AI が洗い出す作業。
_Avoid_: 影響分析, 波及調査

**破壊的変更**:
参照・契約の破壊（削除/リネーム/パス変更/入出力契約の変更）のうち、機械的な参照追従修正では解決できないもの。
_Avoid_: breaking, 互換性破壊

**合意フェーズ**:
AI が課題の全リストを提示した後、課題一つずつを対話して対処を確定する段階。
_Avoid_: レビューフェーズ, 確認フェーズ

**改修フェーズ**:
全課題の合意が揃った後に AI が一括で改修を実施する段階。
_Avoid_: 実装フェーズ, 修正フェーズ

**repo エントリ**:
`bun-global.yml` で GitHub ホストパッケージを宣言する `repo:` フィールド持ちのエントリ。`repo: <owner>/<name>` はデフォルトブランチ最新への追従を意味する。
_Avoid_: git エントリ, GitHub パッケージエントリ

**version エントリ**:
`bun-global.yml` で registry パッケージを宣言する `version:` フィールド持ちのエントリ。repo エントリと相互排他。
_Avoid_: npm エントリ, registry エントリ

**ファイルレベル指摘**:
行紐づけを持たない指摘。hunk のコメントは行紐づけ必須のため、`mt hunk start` が newLine: 1 に合成して表現する。
_Avoid_: ファイル全体コメント, ファイルスコープ指摘

**position 合成**:
`mt hunk start` が行指定なしのコメントに `{"newLine": 1}` を付与して hunk の必須スキーマを満たす動作。
_Avoid_: 正規化, フォールバック

**OpenCLI**:
jackwener/OpenCLI（npm: `@jackwener/opencli`）。ログイン済み Chrome を Browser Bridge 拡張経由で操作し、Web サイトを決定論的な CLI として提供するツール。エージェントブラウザとして採用。
_Avoid_: opencli.org / opencli.dev の仕様プロジェクトとの混同

**Browser Bridge**:
OpenCLI が Chrome/Chromium に接続するための軽量ブラウザ拡張 + ローカルデーモン。拡張は Chrome Web Store から手動インストールする。
_Avoid_: bridge extension, 拡張機能一般

**ad-hoc 操作**:
`opencli browser <session>` プリミティブ（open / click / extract 等）による、その場限りのブラウザ操作。アダプタ化された決定論的コマンドの対義。
_Avoid_: 生操作, 手動ブラウザ操作

**アダプタ化**:
あるサイトに対する操作を OpenCLI のアダプタ（`opencli <site> <command>` 形式の再利用可能コマンド）として定式化すること。
_Avoid_: CLI 化, ラッパー化

**受け入れ検証**:
エージェントブラウザの置換を完了と宣言するための最小検証。opencli doctor 正常・Chrome 拡張接続・ad-hoc 操作成功・組み込みアダプタ実行の各項目で構成される。
_Avoid_: POC, スモークテスト

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

## herdr ワークスペーステンプレート

**mt herdr workspace template**:
herdr のワークスペース設定状態を名前付きテンプレートとして作成・一覧・反映・削除する `mt` の機能。
_Avoid_: herdr template, workspace preset

**ワークスペース**:
herdr が管理するタブと pane のまとまりで、設定状態を保存・反映する対象。
_Avoid_: worktree, window, session

**pane**:
ワークスペース内で個別の作業ディレクトリを持つ作業領域。
_Avoid_: panel, split

**設定状態**:
ワークスペースのタブ・pane の構成、配置、およびそれらを再現するための設定を表す状態。
_Avoid_: layout, snapshot

**テンプレート**:
名前を持つ設定状態の保存単位。特定のワークスペースや cwd に属さず、別のワークスペースで再利用できる。
_Avoid_: preset, profile, snapshot

**反映**:
選択したテンプレートの設定状態を、反映コマンドの実行対象ワークスペースへ適用する操作。
_Avoid_: 適用, 復元

**反映時 cwd**:
反映コマンドを実行した時点の現在の作業ディレクトリ。テンプレートには含めず、反映時にすべての pane の cwd として使う。
_Avoid_: template cwd, saved cwd

**ユーザー共通 JSON**:
リポジトリやワークスペースに依存せず、ユーザー単位でテンプレートを保存する JSON ファイル。
_Avoid_: repository-local JSON, workspace-local JSON
