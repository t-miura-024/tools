# mt

個人開発支援用の CLI ツール集（Rust）。

## Prerequisites

- Rust 1.85+ (edition 2024)
- 外部依存: `fzf`, `gh` (GitHub CLI), `ngrok`, `opencode`, `curl`, `ssh`, `brew`, `mise`, `docker`

## Install

```bash
cargo install --path .
```

## Subcommands

| Command                        | Description                           |
| ------------------------------ | ------------------------------------- |
| `mt`                           | fzf による対話型スクリプトセレクター   |
| `mt self install`              | mt バイナリを cargo install + zshrc 環境整備 |
| `mt agent-config sync`         | Cursor/Claude/OpenCode に設定を同期    |
| `mt agent-config hook --check` | 保護ディレクトリへの直接編集をブロック |
| `mt agent-config bootstrap`    | 初期セットアップ（同期 + post-commit hook 設置） |
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
| `mt tool verify`               | Homebrew、mise、npm global の管理状態を検証 |
| `mt tool brew upgrade`         | Homebrew パッケージを更新              |
| `mt vector ingest`             | Markdown 群を Qdrant に投入（設定ファイル駆動）|
| `mt vector search`             | Qdrant コレクションをベクトル検索        |

## Agent Configuration Management

`agent-configs/` ディレクトリは AI エージェント設定（Cursor/Claude/OpenCode）の Single Source of Truth です。

初回セットアップ:

```bash
mt agent-config bootstrap
```

これにより以下が実行されます:
- `agent-configs/` から各プラットフォームに設定を同期
- `.git/hooks/post-commit` を設置（`agent-configs/` 変更時に自動同期）

設定を変更したら:

```bash
mt agent-config sync
```

Cursor/Claude/OpenCode の設定ディレクトリ（`~/.cursor/`, `~/.claude/`, `~/.config/opencode/`）への直接編集は、hook によってブロックされます。必ず `agent-configs/` を編集してください。

### ディレクトリ構成

`agent-configs/` 直下の `agents/` と `skills/` と `AGENTS.md` はプラットフォーム間で共有されます。opencode 固有のファイル（プラグインなど）は `agent-configs/opencode/` 配下に置きます。

```
agent-configs/
├── AGENTS.md                # 全エージェント共通の指示
├── agents/                  # Cursor/Claude/OpenCode 共通の SubAgent 定義
├── skills/                  # Cursor/Claude/OpenCode 共通の Skill 定義
└── opencode/                # opencode 固有のファイル
    ├── README.md
    └── plugins/             # ~/.config/opencode/plugins/ へデプロイ
        └── cmux-notify.ts   # cmux 通知プラグイン
```

### OpenCode × cmux 統合

`agent-configs/opencode/plugins/cmux-notify.ts` は opencode のプラグインで、opencode のセッション状態変化を cmux に通知し、サイドバータブに status バッジを出します。

購読イベント:
- `session.status` (`busy`) → ⚡️ 青色バッジ "Running" + 進捗インジケータ
- `session.status` (`retry`) → ↻ 橙色バッジ "Retrying"
- `session.status` (`idle`) → バッジクリア
- `session.idle` → バッジクリア + 通知 "Task complete"
- `session.error` → ❌ 赤色バッジ "Error" + 通知 "Error"
- `permission.updated` → 通知 "Waiting for input"

`mt agent-config sync` で `~/.config/opencode/plugins/cmux-notify.ts` へデプロイされ、opencode 起動時に自動ロードされます。`cmux` バイナリが PATH にない場合は no-op で安全（クラッシュしません）。

必要要件:
- [cmux](https://cmux.app/) をインストールし PATH へ追加（`export PATH="/Applications/cmux.app/Contents/MacOS:$PATH"`）
- `mt agent-config sync` を 1 回実行

通知挙動をカスタマイズしたい場合は `agent-configs/opencode/plugins/cmux-notify.ts` を編集して `mt agent-config sync` で反映してください。`~/.config/opencode/plugins/` 配下を直接編集すると `mt agent-config hook --check` によってブロックされます。

## Tool Management

このリポジトリでは `manifests/Brewfile`、`manifests/mise.toml`、`manifests/npm-global.txt` を PC ツール管理の Single Source of Truth として扱います。
初回のみ、mise が repo の設定を読み込めるように trust します。

```bash
mise trust manifests/mise.toml
```

ローカル環境を manifest に合わせるには次を実行します。

```bash
mt tool install
```

`mt tool install` は manifest に書かれたツールをインストールした後、`Brewfile` 管理対象外の依存、未使用の mise tool version、`npm-global.txt` 管理対象外の npm global package を表示します。
削除候補がある場合は確認プロンプトを出し、承認したときだけ削除します。

`npm-global.txt` は npm global package の存在を管理します。
package が CLI binary を提供しない場合、package はインストールされても同名コマンドとして使えるとは限りません。

管理状態を確認するには次を実行します。

```bash
mt tool verify
```

`mt tool verify` は Homebrew の outdated 状態は失敗扱いにせず、manifest に書かれたパッケージが入っているかを確認します。
mise は `mise install --dry-run-code` で、`manifests/mise.toml` に書かれたツールが未インストールなら失敗します。
npm global は `manifests/npm-global.txt` に書かれたパッケージが未インストールなら失敗します。
verify は確認だけを行い、不足しているツールのインストールは行いません。

Homebrew でインストール済みのパッケージを最新化するには次を実行します。

```bash
mt tool brew upgrade
```

`mt tool brew upgrade` は Homebrew のみを対象にし、mise のバージョンは自動更新しません。
mise のツールバージョンを変える場合は `manifests/mise.toml` を編集してから `mt tool install` / `mt tool verify` を実行します。
npm global package を変える場合は `manifests/npm-global.txt` を編集します。

## Docker サービス群

`mise run docker-*` タスクは `scripts/docker.sh` 経由で `docker/*/docker-compose.yml` をすべて検出し、`docker compose -f ... -f ...` に連結して実行する。新サービスを追加するときは `docker/<service>/docker-compose.yml` を 1 つ置くだけで良い。

```bash
mise run docker-up    # SearXNG + Qdrant を起動
mise run docker-down  # すべて停止
mise run docker-logs  # ログを追尾
scripts/docker.sh ps  # 状態表示
```

| Service  | Port  | 用途                          | 設定ファイル                    |
| -------- | ----- | ----------------------------- | ------------------------------- |
| SearXNG  | 8080  | メタ検索エンジン              | `docker/searxng/settings.yml`   |
| Qdrant   | 6333  | ベクトル DB（REST コンソール）| `docker/qdrant/docker-compose.yml` |
| Qdrant   | 6334  | ベクトル DB（gRPC）           | 同上                            |

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

## Worktree Workflow

Git worktree での一連の作業を `mt git` の 4 ステップで標準化します。

| ステップ | コマンド | 責務 |
| --- | --- | --- |
| 1. 環境構築 | `mt git worktree create` | 新しい worktree と feature branch を対話的に作成 |
| 2. 最新化 | `mt git sync [--target <branch>]` | 現在のブランチを upstream に同期し、target の変更を取り込み |
| 3. 作業 | （お好みのエディタ） | 通常の開発作業 |
| 4. マージ & プッシュ | `mt git ship [--target <branch>] [-m <message>]` | コミット → push → target に no-ff マージ → push |

### `mt git sync`

worktree に入った直後に実行する「最新化」コマンドです。

- 現在のブランチを `git fetch` + `git merge --ff-only origin/<current>` で upstream に同期
- `--target <branch>` を明示、または未指定なら fzf でローカルブランチから選択（デフォルトブランチが先頭ソート）
- target ブランチの変更を現在のブランチへ `git pull --no-rebase origin <target>` で取り込み

```bash
# target を明示して sync
mt git sync --target main

# 引数なし: fzf で target を選択（デフォルトブランチが先頭）
mt git sync
```

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
```

### ワークフロー例

```bash
# 1. 環境構築
mt git worktree create
# → ~/src/tools-wt-1-wt-3 が新規 worktree として作成される

# 2. 最新化（main の変更を取り込んでから作業開始）
cd ~/src/tools-wt-1-wt-3
mt git sync --target main

# 3. 作業
vim src/main.rs
git add -p   # 個別に確認しながらステージング
# あるいは mt git ship が自動で git add するので、ここでは省略可

# 4. マージ & プッシュ
mt git ship --target main -m "feat: add new command"
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
  cli/          # self_cmd (install), launcher, style utilities
  git/          # GitHub repository operations
  opencode/     # OAuth setup, ngrok expose/stop
  tool.rs       # Homebrew and mise tool management
  agent_config/ # Cursor/Claude/OpenCode config sync
  vector/       # Markdown ベクトル検索（config / chunk / embed / qdrant / ingest / search）
  main.rs       # Entry point with clap subcommands
agent-configs/  # AI agent configs (Source of Truth)
  agents/       # SubAgent definitions
  skills/       # Skill definitions
  opencode/     # opencode 固有ファイル（plugins/ など）
  AGENTS.md     # Core rules (synced to CLAUDE.md, etc.)
docker/         # Docker Compose services (1 サブディレクトリ = 1 サービス)
  searxng/      # SearXNG (settings.yml, docker-compose.yml)
  qdrant/       # Qdrant (docker-compose.yml)
scripts/        # docker.sh (docker compose ラッパー)
manifests/      # Homebrew, mise, npm global manifests
```

## Development

```bash
cargo fmt           # Format code
cargo clippy        # Lint
cargo test          # Run tests
cargo build         # Build
```
