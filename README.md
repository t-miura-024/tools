# mt

個人開発支援用の CLI ツール集（Rust）。

## Prerequisites

- Rust 1.85+ (edition 2024)
- 外部依存: `fzf`, `gh` (GitHub CLI), `ngrok`, `opencode`, `curl`, `ssh`, `brew`, `mise`, `docker`, `chezmoi`, `age`

## Install

```bash
cargo install --path .
```

## Subcommands

| Command                        | Description                           |
| ------------------------------ | ------------------------------------- |
| `mt`                           | fzf による対話型スクリプトセレクター   |
| `mt self install`              | mt バイナリを cargo install + chezmoi apply で dotfile 展開 |
| `mt chezmoi apply`             | chezmoi ソースを `~` に展開            |
| `mt chezmoi init`              | chezmoi ソースを初期化                  |
| `mt chezmoi diff`              | chezmoi ソースと `~` の差分プレビュー   |
| `mt chezmoi status`            | chezmoi 管理対象の状態を表示            |
| `mt chezmoi doctor`            | chezmoi ネイティブ doctor + mt 固有チェック |
| `mt chezmoi add`               | 既存ファイル / ディレクトリを chezmoi ソースに追加 |
| `mt chezmoi edit`              | chezmoi ソースのファイルを編集          |
| `mt chezmoi install-hook`      | post-commit hook を冪等に設置（chezmoi apply + 旧 hook クリーンアップ）|
| `mt chezmoi uninstall-hook`    | post-commit hook を無効化する手順を案内 |
| `mt git sync`                 | 現在のブランチを upstream 同期 + target を pull で取り込み |
| `mt git ship`                  | 自身のブランチで commit & push → target に no-ff マージ & push |
| `mt git repo create`           | GitHub リポジトリを対話的に作成        |
| `mt git repo select`           | ~/doc, ~/src から親 Git リポジトリを選択してパスを出力（worktree は対象外、`git worktree select` を使用） |
| `mt git worktree select`       | Git worktree を選択してパスを出力      |
| `mt git worktree create`       | Git worktree と新規ブランチを対話的に作成 |
| `mt git worktree delete`       | Git worktree を対話的に削除（多段ガード + 復旧ヒント） |
| `mt opencode oauth setup`      | Google OAuth のセットアップ            |
| `mt opencode web expose`       | OpenCode Web を ngrok で公開           |
| `mt opencode web stop`         | OpenCode Web の公開を停止              |
| `mt tool install`              | manifest からツールをインストール      |
| `mt tool verify`               | Homebrew、mise、bun global の管理状態を検証 |
| `mt tool brew upgrade`         | Homebrew パッケージを更新              |
| `mt vector ingest`             | Markdown 群を Qdrant に投入（設定ファイル駆動）|
| `mt vector search`             | Qdrant コレクションをベクトル検索        |
| `mt agent sync`                | agents / skills を cursor canonical から Claude / OpenCode へ同期 |
| `mt agent sync --check`        | 同期状態のみ確認（drift ありで非0終了）   |
| `mt raycast sync`              | Raycast 設定をエクスポートして chezmoi 管理下に保存 |
| `mt raycast restore`           | バックアップから Raycast 設定を復元      |
| `mt plan draft`                | 新しい計画 Issue を draft で作成          |

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [chezmoi/README.md](chezmoi/README.md) | dotfiles と AI agent 設定（agent / skill / hook）の管理 |
| [manifests/README.md](manifests/README.md) | PC ツール管理の Single Source of Truth（Brewfile / mise.toml / bun-global.yml） |
| [docker/README.md](docker/README.md) | Docker Compose サービス群（SearXNG / Qdrant） |
| [docs/adr/](docs/adr/) | アーキテクチャ決定記録（ADR） |

## Vector Search (Markdown ベクトル検索)

`mt vector` はローカルの Markdown 群を Qdrant に投入し、ベクトル検索する。設定は `vector.config.toml` 1 つで完結し、Qdrant の URL や埋め込みモデル、チャンク戦略を切り替えられる。

```bash
# Qdrant を起動（SearXNG と並列）
mise run docker-up

# Markdown を Qdrant に投入
mt vector ingest --config ./vector.config.toml

# 類似検索（結果は JSON）
mt vector search --config ./vector.config.toml --query "恐竜の定義"
```

`vector.config.toml` の例:

```toml
collection_name = "paleo_blog"
doc_dir = "doc"

# 任意項目（デフォルトで十分なら省略可）
# qdrant_url = "http://localhost:6333"
# vector_dim = 384
# chunk_pattern = "^#{1,3}\\s+"
# batch_size = 32
# top_k = 20
# embed_model = "dummy-sha256"
# title_key = "title"
# source_key = "source"
```

埋め込みは Phase 1 では SHA-256 ベースのダミー実装で、ONNX ランタイム統合は別計画で取り組む。

## Raycast Settings Backup

Raycast の設定（Export 11 カテゴリ: Settings / Snippets / Quicklinks / Notes / MCP Servers / Extensions / Hotkeys / AI Chats 等）を chezmoi 経由でバックアップ・リストアします。

Export/Import は Raycast アプリ内の GUI 操作で行い、`mt` は deeplink 起動・ファイル配置・手順表示を担当します。管理ファイルの詳細は [chezmoi/README.md](chezmoi/README.md) を参照してください。

### 使い方

```bash
# Raycast 設定をエクスポートして chezmoi 管理下に保存
mt raycast sync
# → Raycast Export 画面が開く → passphrase を表示 → .rayconfig を chezmoi に取り込み → コミット手順を表示

# 別の Mac で復元
mt raycast restore
# → バックアップパスと passphrase を表示 → Raycast Import 画面が開く → GUI で Import 手順を案内
```

## Worktree Workflow

Git worktree での一連の作業を `mt git` の 4 ステップで標準化します。

| ステップ | コマンド | 責務 |
| --- | --- | --- |
| 1. 環境構築 | `mt git worktree create` | 新しい worktree と feature branch を対話的に作成 |
| 2. 最新化 | `mt git sync [--target <branch>] [--target-default]` | 現在のブランチを upstream に同期し、target の変更を取り込み |
| 3. 作業 | （お好みのエディタ） | 通常の開発作業 |
| 4. マージ & プッシュ | `mt git ship [--target <branch>] [--target-default] [-m <message>]` | コミット → push → target に no-ff マージ → push |

### `mt git sync`

worktree に入った直後に実行する「最新化」コマンドです。

- 現在のブランチを `git fetch` + `git merge --ff-only origin/<current>` で upstream に同期
- `--target <branch>` を明示、`--target-default` でデフォルトブランチを自動選択、未指定なら fzf でローカルブランチから選択（デフォルトブランチが先頭ソート）
- target ブランチの変更を現在のブランチへ `git pull --no-rebase origin <target>` で取り込み

```bash
# target を明示して sync
mt git sync --target main

# デフォルトブランチ（main / master / origin/HEAD）を自動選択（fzf 起動しない）
mt git sync --target-default

# 引数なし: fzf で target を選択（デフォルトブランチが先頭）
mt git sync
```

> `--target` と `--target-default` は同時に指定できません。

### `mt git ship`

worktree を出る直前に実行する「マージ & プッシュ」コマンドです。

- target ブランチ（デフォルトブランチ）を `git pull --ff-only` で最新化
- 現在のブランチで `git add` + `git commit`（`-m` 引数がなければ `git diff --staged --shortstat` から軽量自動生成）
- `git push -u origin HEAD`
- target に `git merge --no-ff <feature>` でマージコミット作成 → `git push origin <target>`
- 元のブランチに戻る

```bash
# コミットメッセージを指定して ship
mt git ship --target main -m "fix: handle edge case"

# 自動生成されたコミットメッセージで ship（-m 未指定）
mt git ship --target main

# デフォルトブランチを自動選択して ship
mt git ship --target-default -m "feat: add new command"
```

> `--target` と `--target-default` は同時に指定できません。

### ワークフロー例

```bash
# 1. 環境構築
mt git worktree create
# → ~/src/tools-wt-1-wt-3 が新規 worktree として作成される

# 2. 最新化（main の変更を取り込んでから作業開始）
cd ~/src/tools-wt-1-wt-3
mt git sync --target-default

# 3. 作業
vim src/main.rs
git add -p   # 個別に確認しながらステージング
# あるいは mt git ship が自動で git add するので、ここでは省略可

# 4. マージ & プッシュ
mt git ship --target-default -m "feat: add new command"
# → 変更を commit → push → main に no-ff マージ → push
```

### 安全性

- デフォルトブランチ（`main` / `master`）上での `sync` / `ship` はエラーで中断
- 任意の git 操作が失敗したら即座に中断し、現在の git 状態スナップショット（HEAD / 未コミット変更 / stash）を表示
- リカバリ選択肢（abort / rebase 手順 / force 手順）から選んで次のアクションを決定
- 対話入力ができない環境（CI 等）では自動的に abort 扱いで exit 1

## Project Structure

```
src/
  agent/        # AI agent 設定同期（mt agent sync）
  chezmoi/      # chezmoi ラッパーコマンド
  cli/          # self_cmd (install), launcher, style utilities
  git/          # GitHub リポジトリ・worktree 操作
  opencode/     # OAuth setup, ngrok expose/stop
  plan/         # 計画管理（mt plan/run-plan）
  raycast/      # Raycast 設定バックアップ（sync / restore）
  tool/         # Homebrew、mise、bun global 管理
  vector/       # Markdown ベクトル検索（config / chunk / embed / qdrant / ingest / search）
  config.rs     # 設定ファイル読み込み
  main.rs       # Entry point with clap subcommands
chezmoi/        # chezmoi ソース（dotfiles の Source of Truth）
  dot_cursor/   # AI agent 設定 canonical
  dot_claude/   # Claude Code 派生設定（mt agent sync で自動生成）
  dot_config/   # OpenCode 派生設定（mt agent sync で自動生成）
docker/         # Docker Compose services (1 サブディレクトリ = 1 サービス)
  searxng/      # SearXNG (settings.yml, docker-compose.yml)
  qdrant/       # Qdrant (docker-compose.yml)
docs/
  adr/          # アーキテクチャ決定記録（ADR）
scripts/        # docker.sh (docker compose ラッパー)
manifests/      # ツール管理マニフェスト（Single Source of Truth）
```

## Development

```bash
cargo fmt           # Format code
cargo clippy        # Lint
cargo test          # Run tests
cargo build         # Build
```
