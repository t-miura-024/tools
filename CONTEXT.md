# mt CLI

個人用 CLI ツール群。Git / chezmoi / ツール管理 / ベクトル検索 / difit レビュー等のサブコマンドを持つ。

## Language

**difit レビューセッション**:
`mt difit start` で始まり `mt difit check` または `mt difit done` で終わる、difit サーバとコメント状態のライフサイクル。状態は `.difit/difit-review.json`（port / pid / comments / difit_args / selection）で追跡し、`selection` はコメント読み書きを固定する解決済みの diff 選択（選択キー）を持つ。`start` の再入時は同一 difit 引数・選択キー記録済みの実行中サーバを再利用し、選択固定の comment-imports（HTTP POST `/api/comment-imports` に `mt difit threads --json` と同じ `base` / `target` / `baseMode` クエリを付与）でコメントを追記してポートを維持する。外部 CLI の `difit comment add` / `comment get` は選択を指定できない（unpinned な `currentCommentSelection` を読み書きする）ため mt は使わない。レビュー表示は `mt difit start` が stdout に返す URL を人間に提示するのみで、herdr / terminal-browser に依存しない。
_Avoid_: review session, difit session

**選択キー**:
difit がコメントを分離して保持する diff の選択（base / target / baseMode）。`mt difit start` が起動直後に `/api/diff` から解決済みの値を取得して状態（`selection`）へ永続化し、コメントの get / add と `check` のゲート判定をこの選択に固定する（ブラウザ UI のリビジョン切替で別セッションを読まない）。`check` は未記録の状態を fail-closed で止める。外部 CLI の `difit comment resolve` は選択を指定できないため、UI 操作は起動時のリビジョンに戻して行う。
_Avoid_: diff selection, comment selection

**選択ドリフト**:
difit のブラウザ UI が起動時の選択（`selection`）と異なる選択に切り替わっている状態。`mt difit check`（通常 / `--dry-run`）と `mt difit threads --json` が `selection_drift: {detection, expected, current}` で報告し、`detection` は `detected`（不一致）/ `none`（一致）/ `unavailable`（probe 失敗＝検知不能）の三値。`unavailable` を「ドリフトなし」に倒さず、ワークフローは `none` 以外を fail-closed で扱う。
_Avoid_: revision drift, selection mismatch

**スレッド**:
difit のコメント単位。親メッセージと reply からなる。resolve 済みは読み取りに現れない。mt の読み取りは選択固定・read-only の `mt difit threads --json` に統一する（unpinned な `difit comment get` は使わない）。
_Avoid_: comment, discussion

**gate**:
`mt difit check` による通過/ブロック判定。ブロッキングの未 resolve スレッドがなければ exit 0、あれば exit 1。want（人間 reply なし）と AI の `[context]` はノンブロッキング。author が `User` の人間 reply が付いた非ブロッキング・スレッド（want / AI の `[context]`）はブロッキングに昇格し、author を持たない reply は人間とみなさない。`--dry-run` は後始末（サーバ停止・状態削除）をしない非破壊モードで、出力と exit code は通常の check と同一。
_Avoid_: check, validation

**taxonomy**:
コメント親本文の分類。現行テンプレートの `🐛 issue` / `🙋 question` は 1 行目ヘッダの `·` 区切りトークンとしてのみ認識し、旧形式の先頭プレフィックス（`[issue]` / `[question]` / `[context]`）も互換認識する。詳細本文中の文字列は判定に使わない。`[context]`（解説、非ブロッキング）は AI フローからは注入しない。author が `User` の投稿は本文の分類によらず人間コメントとして扱う。
_Avoid_: category, label, type

**コメント**:
difit サーバに登録される行紐づきスレッド。AI コメント（must / should / want）と人間コメントがあり、ゲート判定はブロッキングの未 resolve スレッドの有無で行う。
_Avoid_: annotation, note

**resolve**:
スレッドを解決済みにすること。difit UI、選択固定・同一性検証つきの `mt difit resolve <threadId>`、または外部 CLI の `difit comment resolve` で行い、ゲート通過の主機構となる。エージェントは修正済みの AI 指摘を `mt difit resolve` で resolve し（state 読み取り → 記録 pid の LISTEN 照合 → 選択固定セッションへの DELETE を 1 コマンド化。親 author が人間のスレッドは拒否）、人間コメントは人間が resolve する。
_Avoid_: 解決, 削除, rm

**want**:
ノンブロッキングの AI 指摘。ゲートをブロックしない。人間が reply した want スレッドのみブロッキングに昇格し、次ラウンドの修正対象となる。
_Avoid_: 任意指摘, suggestion

**stale state**:
`.difit/difit-review.json` が存在するが difit サーバを検出できない状態。`start` / `check` が自己修復する。
_Avoid_: orphan, zombie

**サーバ同一性検証**:
kill の前に、記録された pid が記録された port を LISTEN していることを OS 情報で照合する安全確認。照合できない pid は停止せず警告のみを残す（fail-closed）。読み取り専用の `mt difit check --dry-run` / `mt difit threads --json` も同じ照合を要求し、照合不能なら state を変更せず非 0 exit する。
_Avoid_: pid check, listener check

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
行紐づけを持たない指摘。difit の comment import スキーマは position 必須のため、`mt difit start` の stdin 直 import が `{"side":"new","line":1}` に合成して表現する（注入は選択確定後の HTTP POST `/api/comment-imports`）。mt-review-diff の findings は position 必須で、欠落は機械的に除外され合成されない。
_Avoid_: ファイル全体コメント, ファイルスコープ指摘

**position 合成**:
`mt difit start` が stdin 直 import の行指定なしコメントに `{"side":"new","line":1}` を付与して difit の必須スキーマを満たす動作。
_Avoid_: 正規化, フォールバック

**レビューコメントテンプレート**:
difit に注入する AI レビュー指摘の表示構造。GFM Markdown で severity（🚨 must / ⚠️ should / 💡 want）と taxonomy（🐛 issue / 🙋 question）を絵文字で区別し、対象・詳細・提案を構造化する。本文の `[` / `]` はコードスパン外でエスケープし、画像・リンク記法をリテラル化する（外部 URL の自動リクエスト防止）。
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

**mt herdr tab template**:
herdr の単一タブ設定状態を名前付きタブテンプレートとして作成・反映・削除する `mt` の機能。ワークスペース用とは型・保存先を分離する。
_Avoid_: herdr template, tab preset

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

**round_limit_gate**:
plan-run がレビューの round 上限（3）到達・停滞時に提示する human_gate 群。未通過は `round_limit_gate`（受容して完了処理へ / もう1巡続ける / 中断）、通過済みは `round_limit_passed_gate`（上限到達・通過済み。後始末へ / 中断）、round 停滞は `round_stall_gate`（このまま次のレビューサイクルへ進む / execute_work からやり直す / 中断）を提示する。round 上限到達時の受容（approve）は後続の `release_difit_session` が `mt difit done` で difit セッション（サーバ・state）を後始末し（state 消失と記録 pid の終了まで検証）、finalize_done へ進む。「もう1巡」（revise）と round 停滞のやり直しはセッションを残して次ラウンドの start_difit_review が再利用する。中断（abort）はいずれのゲートでもエンジン終了のため後始末されず、手動 `mt difit done` を案内する。mt-review-diff 単独では round limit は fail で終端する。
_Avoid_: round gate, 上限ゲート

**検証観点**:
差分を敵対的に崩す独立した視座。旧資材のマクロ/ミクロ/共通を正規化した 15 観点のプールで管理する。
_Avoid_: レビュー観点, perspective

**ティア**:
検証観点プールの優先度階層。T1 最優先〜T5。width が採用するティア数を決める。低 width は T1 のみ、高 width は全ティア。
_Avoid_: priority, level

**difit 方式**:
`mt difit` CLI（difit Web UI の検証セッション）を使い、指摘を差分上のスレッドコメントとして管理する方式。
_Avoid_: difit レビュー, 差分コメント方式

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
