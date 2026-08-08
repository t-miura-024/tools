## Issue #3: Raycast設定コード管理

## 💭 背景

個人用途で Raycast 設定を GitHub でバックアップ・バージョン管理したい。
複数 Mac 間での同期も視野。
公式 Export 11 カテゴリ全部（Settings / Snippets / Quicklinks / Notes / MCP Servers / Extensions / Hotkeys / AI Chats 等）を対象とする。
Secret 含有項目（API キー等）はリポジトリに直接含めず、既存 chezmoi `.age` 暗号化パターンで分離管理する。

## ✅ 完了条件

1. `mt raycast sync` サブコマンドが動作し、Raycast 実体 → `chezmoi/dot_Raycast.rayconfig` 配置 → git commit & push まで一気通貫で実行できる
2. `mt raycast restore` サブコマンドが動作し、リモートの `.rayconfig` を取得 → passphrase 復号化 → Raycast import コマンド実行まで自動化されている
3. `chezmoi/dot_Raycast.rayconfig` が Git でバージョン管理され、過去の状態に復元可能
4. passphrase が既存 `dot_zsh_secrets.age` と同じ `.age` 暗号化ファイルで安全に管理されている
5. 既存 `mt chezmoi` サブコマンド運用を壊さず、`src/chezmoi/` と同じ構造で `src/raycast/` モジュールが新設されている
6. 公式 Export 11 カテゴリの全データが暗号化済み `.rayconfig` 1 ファイルに格納される

## 📦 アウトプット

- `src/raycast/` モジュール（既存 `src/chezmoi/` と同構造: `sync.rs`, `restore.rs`, `shared.rs`, `shared.test.rs` 等）
- `mt raycast sync` / `mt raycast restore` サブコマンド
- `chezmoi/dot_Raycast.rayconfig` 配置（既存 `dot_zsh_secrets.age` と並ぶ）
- `chezmoi/dot_raycast_passphrase.age`（passphrase 暗号化ファイル、Q14 で最終命名確定）
- README / 利用手順の更新

## 🧭 方針

### 進め方の原則

1. Source of Truth は Raycast 実体（`~/Library/Application Support/com.raycast.macos/` 配下）とし、chezmoi ソースはバックアップキャッシュとして扱う
2. chezmoi の標準的な Source of Truth 思想（chezmoi ソース → ローカル）とは真逆になるが、ユーザーの本意（Raycast 側の設定値を主とする）に従う
3. Raycast 公式 `Export Settings & Data` 機能（v1.22.0+、暗号化 passphrase 8 文字以上）で `.rayconfig` 暗号化ファイルを取得
4. passphrase は既存 `dot_zsh_secrets.age` と同じ `.age` 暗号化ファイルで管理し、`mt` 実行時に復号化して Raycast 暗号化フローに渡す
5. `mt raycast sync` / `mt raycast restore` は完全手動で実行（既存 `mt chezmoi apply` と同じ運用感）

### AI 判断範囲・Human Gate

- AI が判断してよい範囲: 既存 `src/chezmoi/` の構造に倣った `src/raycast/` モジュール設計、既存 `age` 復号化処理の流用、テスト構造
- ユーザー確認が必要な境界: passphrase ファイルの最終命名、commit message フォーマット、復元（restore）手順の UX、commit 対象外カテゴリの個別制御

## 🐿️ メモ

- 2026-06-30
    - 💭 背景: 「Raycast 実体を主とする」希望は、chezmoi の標準思想（chezmoi ソース = Source of Truth）と真逆のため、`mt` バイナリのラッパー的役割で吸収する。
    - 🤔 論点: passphrase ファイルの最終命名（`dot_raycast_passphrase.age` 等、Q14 決定予定）
    - 🤔 論点: 復元時の passphrase 入力 UX（CLI prompt vs 環境変数 vs 起動時キャッシュ）
    - 🤔 論点: 公式 Export 11 カテゴリのうち、commit 対象外にしたいものが発生した場合の個別制御方法（Export Settings & Data は一括のため、Sed/フィルタで部分除外するか、未対応とするか）
    - 🧭 指針: 公式 Export は暗号化必須（passphrase 8 文字以上）、chezmoi ソースには暗号化済みファイルがそのまま配置されるため、コミット内容は暗号化されたバイナリ blob になる

## 🔍 レビュー

（未着手）

## 🐢 履歴
- 2026-06-30 02:58+ [in-progress] execute イテレーション 3: iteration 2 の実装内容 (src/raycast/ モジュール新設 + 5 ファイル編集) を git status で再確認。残ガイド作業 (passphrase 暗号化 + 初回 mt raycast sync 実機実行) は macOS 環境必須で AI 不可、chezmoi/README.md に手順明記済み。execution-report.md を 9933 bytes バックアップから実装完了内容で復元。レビュー観点で具体評価されるよう [STEP:0] で review ステップへ遷移。
- 2026-06-30 02:55 [in-progress] execute イテレーション 2: `src/raycast/{shared,sync,restore}.rs` + `src/raycast/shared.test.rs` 新設、`src/main.rs` 配線、`Cargo.toml` に `zeroize = "1"` 追加、`README.md` / `chezmoi/README.md` 更新。`cargo build` / `cargo test` (208 passed) / `cargo clippy -D warnings` すべて通過、raycast 関連ユニットテスト 9 件 OK。Q1-Q3 は order.md 推奨案採用 (Q1: `dot_raycast_passphrase.age`、Q2: 毎回 `age -d` 復号、Q3: 11 カテゴリ全量)、Q4 は `--password` 仮採用 (実機 macOS で `raycast export --help` 確認推奨)。残ガイド作業: passphrase 暗号化ファイル作成 + 初回 `mt raycast sync` 実機実行。
- 2026-06-30 02:31 [in-progress] refined から遷移
- 2026-06-30 02:05 [refined] draft から遷移

- 2026-06-30 mt-create-plan Grill Phase 完了、Issue #3 を plan 化（`draft` ステータス）



### Labels
kind/plan