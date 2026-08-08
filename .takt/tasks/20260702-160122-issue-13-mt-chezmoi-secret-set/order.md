## Issue #13: mt chezmoi secret set サブコマンド追加

## 💭 背景

### takt 設定エラーの解消（先行課題）

- `takt` 実行時に `provider 'opencode' requires model in 'provider/model' format` エラーが発生
- 原因: `~/.takt/config.yaml` に `model` フィールドが未定義
- 解消には `model: opencode/<provider>/<model>` の追加が必要
- OpenCode プロバイダは SDK ベースのため、OpenCode の API キーも別途必要

### dot_zsh_secrets.age への手動追加が煩雑

- 既存運用: `age-keygen -y` → 復号 → 追記 → 暗号化 → apply → 平文削除の 6 ステップ
- secrets 追加のたびにこの手順を踏むのは非効率
- 「zshrc に secret を簡単に追加できる」仕組みが求められている

### 既存運用との整合性

- 既存の chezmoi + age 暗号化パターンを尊重
- AGENTS.md の方針「既存 Source of Truth 尊重」「同じ情報をむやみに重複させない」に沿う
- `dot_zsh_secrets.age` の中身フォーマット（`export XXX=...`）を維持
- `mt` CLI の既存 chezmoi サブコマンド（`add` / `edit` / `doctor` / `install-hook`）と同じ UX

## ✅ 完了条件

1. `mt chezmoi secret set <KEY>` が 1 コマンドで完結する
2. value は `dialoguer` の Password プロンプトで入力され、シェル履歴・プロセスリストに平文が残らない
3. 既存 KEY がある場合は値を出さずに Y/n で上書き確認される
4. 再暗号化失敗時に `.age` ファイルが破損しない（atomic write による一時ファイル経由）
5. `--dry-run` フラグで書き込み内容を事前プレビューできる
6. `CHEZMOI_SOURCE_DIR` 環境変数 / `~/.config/chezmoi/chezmoi.toml` の `sourceDir` / デフォルト `~/src/tools/chezmoi` の優先度で source ディレクトリが解決される
7. set 実行後に `mt chezmoi apply` を Y/n 確認の上で実行できる
8. 追加される平文フォーマットは `# <KEY>（<timestamp>）` + 空行 + `export <KEY>=<VALUE>` の 3 行ブロック
9. `cargo build` / `cargo test` が通る
10. `chezmoi/README.md` に `mt chezmoi secret set` の手順が追記されている
11. takt のエラーが `~/.takt/config.yaml` の `model` 追加 + `TAKT_OPENCODE_API_KEY` 設定で解消される

## 📦 アウトプット

### コード変更

- `src/chezmoi/secret.rs`（新規、`set` サブコマンド本体）
- `src/chezmoi/secret.test.rs`（新規、ユニットテスト）
- `src/chezmoi.rs`（修正、`Secret` バvariant 追加）
- `src/chezmoi/shared.rs`（修正、`resolve_source_dir()` を `chezmoi.toml` 対応に拡張）
- `Cargo.toml`（修正、`chrono = "0.4"` 追加）

### ドキュメント

- `chezmoi/README.md`（更新、`mt chezmoi secret set` の手順と `secrets の追加・更新` 節の刷新）

### ユーザー設定

- `~/.takt/config.yaml`（`model: opencode/<provider>/<model>` 追加）
- `chezmoi/dot_zsh_secrets.age`（`export TAKT_OPENCODE_API_KEY=...` 追加・再暗号化）

## 🧭 方針

### 進め方の原則

1. 既存パターンの尊重: `src/chezmoi/add.rs` / `edit.rs` と同じ構造（`shared::run_chezmoi` 経由）を踏襲しつつ、ファイル操作は Rust 側で完結（chezmoi には依存しない）
2. 依存追加の最小化: `chrono` のみ追加（タイムスタンプ生成のため）。`age` クレートは使わず `age-keygen` / `age -d` バイナリ呼び出しで十分
3. atomic write: 一時ファイル `.age.new` 経由の `mv` で原子的に差し替え。中途半端な状態を残さない
4. 機密値の露出禁止: 値本体は Password プロンプトで隠す。既存 KEY 確認時も値を出さない
5. テストは純粋ロジックに集中: 外部プロセス（age / chezmoi / dialoguer）に依存する統合テストはスコープ外。KEY バリデーション・grep ロジック・パス解決のみユニットテスト
6. README 更新: 既存 `secrets の追加・更新` 節を刷新し、`mt chezmoi secret set` を推奨手順として前面に

### AI 判断範囲・Human Gate

- AI 判断: 具体的な実装コード、エラーメッセージ文言、テストケースの内容、タイムスタンプ形式の詳細（ISO 8601 vs RFC 3339 など）
- Human Gate: 以下はユーザーに確認
  - どの `provider/model` を `model` に設定するか（OpenCode アカウントで実在する ID が必要）
  - 追加する最初の KEY として `TAKT_OPENCODE_API_KEY` で開始して良いか
  - README の記述内容・順序

## 🐿️ メモ

- 2026-06-28
  - 💭 背景: 既存 `secrets の追加・更新` 節は 5 ステップ手順で記述されており、新規ユーザーには手順が多い。`mt chezmoi secret set` で 1 コマンド化することで、新規・既存ユーザー双方の体験が向上する
  - 🤔 論点: `dot_zsh_secrets.age` 以外（例: サブディレクトリ配下の `.age`）への対応は将来検討。本計画では `dot_zsh_secrets.age` のみ対象
  - 🤔 論点: 複数 KEY を 1 コマンドで追加する `secret set-multi` のような拡張は将来検討。最初のスコープは `set <KEY>` 単一のみ
  - 🧭 指針: 既存の `dot_zshrc.tmpl` の `{{ include "dot_zsh_secrets.age" | decrypt }}` は変更しない

## 🐢 履歴
- 2026-06-30 04:10 [in-progress] 実装完了。`secret.rs` 新規 + `shared.rs` 拡張（`resolve_chezmoi_source_dir` / `parse_chezmoi_toml_source_dir` / `validate_env_key_name` / `build_secret_block` / `key_exists_in_plaintext` / `remove_existing_block`）、`chezmoi.rs` に `Secret` バリアント追加、`Cargo.toml` に `chrono = "0.4"` 追加、`chezmoi/README.md` の secrets 節を刷新。`cargo build` / `cargo test` / `cargo clippy --all-targets` すべて成功（unit 178 + chezmoi-cli 13 passed）。`~/.takt/config.yaml` の `model` 設定と `dot_zsh_secrets.age` の `TAKT_OPENCODE_API_KEY` 設定は先行して既に存在することを確認。
- 2026-06-30 03:54 [in-progress] refined から遷移
- 2026-06-28 22:34 [refined] draft から遷移

- 2026-06-28 23:30 [draft] 計画作成

### Labels
kind/plan