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

**レビューコメントテンプレート**:
hunk に注入する AI レビュー指摘の表示構造。`markup`（STML）と `summary`（fallback）の二重で表現し、severity（🚨 must / ⚠️ should / 💡 want）と taxonomy（🐛 issue / 🙋 question）を絵文字で区別する。axis は 🎯 essentiality / ✅ acceptance / 📦 scope / 🧭 alignment / ✨ quality で併記し、ヘッダ・対象・詳細・提案の4ブロックで構造化する。
_Avoid_: コメントテンプレート, レビュー書式

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

## Skill構成

**廃止**:
`mt-plan` Skillディレクトリ（`~/.cursor/skills/mt-plan`）を完全に削除し、後方互換のためのShimやdeprecated READMEを残さないこと。
_Avoid_: アーカイブ, 非推奨化

**共通リソース**:
`mt-plan-create` と `mt-plan-run` の双方からimportまたはファイルパス参照されている資材。`init-config` / `init-config-gh` / `transition-plan` / `plan-format` が該当する。
_Avoid_: 共有ファイル, 共通モジュール

**片側専用リソース**:
片方のSkillからのみ参照される資材。`collect-review-context`（run専用）、`list-plans`（run専用）が該当。`sync-sessions` は参照なしのため削除対象。
_Avoid_: 専有リソース

**移行命名**:
`skill/_shared` 配下で `mt-plan-xxx` 形式のkebab-caseファイル名を用いる命名規則。元ファイル名をそのまま付与する（例: `init-config.ts` → `mt-plan-init-config.ts`）。
_Avoid_: リネーム, プレフィックス付与

**テスト基盤**:
`bun:test` ビルトインランナー。`vitest` 依存を削除し `from "bun:test"` で実行する。`package.json` は不要。
_Avoid_: vitest, npm test

## 敵対的検証機構

**effort**:
検証強度の総称。width と depth の2軸で構成。
_Avoid_: 強度, intensity

**width**:
累積ティア制で採用観点集合を決定する effort の軸。low=4〜max=15。
_Avoid_: 広さ

**depth**:
担当観点数で深さを制御する effort の軸。max 1:1〜low 1:all。
_Avoid_: 深さ

**gate**:
`tado confirm` で TTY 必須の人間判定。human_gate ステップの総称。
_Avoid_: check, validation

**question**:
gate内の設問単位。type: single_choice | choice_with_input | free_text。
_Avoid_: 設問

**choice_with_input**:
選択肢単位で付帯入力（input:{required,placeholder,maxLength}）を持つ GateChoice。revise=必須、approve=任意で統一。
_Avoid_: 入力付き選択肢

**outcomeQuestionKey**:
複数設問時の判定代表キー。本計画では `decision` に統一。
_Avoid_: 代表設問

**gateAnswers**:
ConditionCtx.gateAnswers[stepKey][questionKey] の新参照形式。旧 gateChoices/choice は廃止。
_Avoid_: gateChoices

**検証観点**:
差分を敵対的に崩す独立した視座。旧資材のマクロ/ミクロ/共通を正規化した 15 観点のプールで管理する。
_Avoid_: レビュー観点, perspective

**ティア**:
検証観点プールの優先度階層。T1 最優先〜T5。width が採用するティア数を決める。低 width は T1 のみ、高 width は全ティア。
_Avoid_: priority, level

**hunk 方式**:
`mt hunk` CLI（TUI 検証セッション）を使い、指摘を差分 hunk 上のコメントとして管理する方式。
_Avoid_: hunk レビュー, 差分コメント方式

**findings**:
検証者 SubAgent が出力する生指摘の構造化データ。axis/severity/detail/position を持ち、findings.json として集約される。旧 agent-review.json の後継。
_Avoid_: 指摘, review result

**verdict**:
敵対的検証後の判定結果。passed/blocked、blocking_threads、round 番号を持ち、verdict.json として出力される。
_Avoid_: 判定, review result

**Step import**:
tado ワークフロー定義から個別の Step をモジュールとして他ワークフローへ取り込む再利用方式。新ワークフロー定義が SoT。
_Avoid_: shared, 共通化

**敵対的検証**:
差分を「正しいことの確認」ではなく「崩せるかという反証」の視座で容赦なく突く検証スタンス。攻撃者・利用者・保守者の敵対的視点で弱点・前提崩れ・悪用可能性を暴露する。
_Avoid_: レビュー, code review
