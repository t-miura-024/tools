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
| `mt tool verify`               | Homebrew、mise、npm global の管理状態を検証 |
| `mt tool brew upgrade`         | Homebrew パッケージを更新              |
| `mt vector ingest`             | Markdown 群を Qdrant に投入（設定ファイル駆動）|
| `mt vector search`             | Qdrant コレクションをベクトル検索        |
| `mt raycast sync`              | Raycast 設定をエクスポートして chezmoi 管理下に保存 |
| `mt raycast restore`           | バックアップから Raycast 設定を復元      |

## Dotfiles Management with chezmoi

個人 dotfiles（`~/.zshrc`, `~/.zprofile`, `~/.gitconfig`）と AI agent 設定（Cursor / Claude / OpenCode）は `tools` 親リポジトリの `chezmoi/` ディレクトリに集約し、`chezmoi apply` 経由で `~` へデプロイします。Phase 2 で `agent-configs/` を完全廃止し、`mt agent-config` サブコマンドを削除、`chezmoi` 経由に統合しました。

### 初回セットアップ

1. `mt tool install` で chezmoi と age を brew 経由でインストール（`manifests/Brewfile` の `brew "chezmoi"` / `brew "age"` が自動追加される）
2. age 秘密鍵を生成:

    ```bash
    age-keygen -o ~/.config/chezmoi/key.txt
    ```

3. `~/.config/chezmoi/chezmoi.toml` を作成（git コミット対象外、ユーザー固有設定）:

    ```toml
    sourceDir = "/Users/mt/src/tools/chezmoi"
    encryption = "age"

    [age]
    identity = "/Users/mt/.config/chezmoi/key.txt"
    ```

4. dotfile を展開:

    ```bash
    mt chezmoi apply
    ```

### ディレクトリ構成

`chezmoi/` 直下の `dot_cursor/`, `dot_claude/`, `dot_config/opencode/` が Source of Truth です。**`dot_cursor/agents/` が canonical** で、`dot_claude/agents/` と `dot_config/opencode/agents/` は platform-specific frontmatter 形式の 3 重コピーになります。

```
chezmoi/
├── dot_zshrc.tmpl             # ~/.zshrc（テンプレート、API キー復号）
├── dot_zprofile               # ~/.zprofile（plain copy）
├── dot_gitconfig              # ~/.gitconfig（plain copy）
├── dot_zsh_secrets.age        # age 暗号化ファイル（git コミット対象、age 鍵で復号）
├── README.md                  # このファイル（chezmoi apply から除外）
├── dot_cursor/                # ~/.cursor/ へデプロイ
│   ├── agents/                # canonical（name, description, readonly）
│   ├── skills/                # canonical
│   └── hooks.json             # Cursor PreToolUse 設定
├── dot_claude/                # ~/.claude/ へデプロイ
│   ├── CLAUDE.md              # Source of Truth 記述
│   ├── agents/                # Claude 形式（description: Use this agent when...）
│   ├── skills/                # Claude 形式
│   └── settings.json          # Claude PreToolUse 設定
└── dot_config/opencode/       # ~/.config/opencode/ へデプロイ
    ├── AGENTS.md              # Source of Truth 記述
    ├── agents/                # opencode 形式（mode, permission, color）
    ├── skills/                # opencode 形式
    ├── plugins/               # opencode プラグイン
    │   ├── cmux-notify.ts     # cmux 通知プラグイン
    │   ├── mt-loop-engine.ts  # mt loop engine
    │   ├── cursor-hook-bridge.ts  # Cursor の hooks.json を opencode plugin に bridge
    │   └── agent-hooks/
    │       └── block-cursor-config-direct-edit.ts  # 共通 hook スクリプト
    ├── commands/              # opencode slash commands
    │   ├── mt-goal.md
    │   └── mt-loop.md
    └── config.json            # opencode 設定（plugin: cursor-hook-bridge）
```

### 編集ワークフロー

```bash
# 1. canonical（dot_cursor/）を編集
vim ~/src/tools/chezmoi/dot_cursor/agents/foo.md

# 2. dot_claude/, dot_config/opencode/ にも platform-specific 形式で反映
#    （現状は手動 cp。自動変換スクリプトは計画中）

# 3. 差分プレビュー
mt chezmoi diff

# 4. 反映
mt chezmoi apply

# 5. 状態確認
mt chezmoi status

# 6. ソース変更をコミット
cd ~/src/tools
git add chezmoi/
git commit -m "..."
```

`mt self install` を実行すると `chezmoi apply` + `cargo install --path .` が自動実行され、`~/.zshrc` や platform 設定ファイルへの直接書き込みは行いません（chezmoi 経由のみ）。

### `mt chezmoi doctor`

chezmoi ネイティブ doctor に加え、以下を `mt` 固有チェックとして実行:

- `CHEZMOI_SOURCE_DIR` 環境変数 or `~/.config/chezmoi/chezmoi.toml` の `sourceDir` 設定
- `~/.config/chezmoi/key.txt` の存在と妥当性（`AGE-SECRET-KEY-` プレフィックス）
- post-commit hook の設置状態
- `agent-configs/` ディレクトリの削除確認（chezmoi 移管完了確認）
- platform-native hook 4 ファイル（`~/.cursor/hooks.json` / `~/.claude/settings.json` / opencode bridge / 共通 hook スクリプト）の配置確認

### platform-native hook

3 つの platform（Cursor / Claude / OpenCode）に対して chezmoi 経由で `block-cursor-config-direct-edit.ts` を共通配置し、保護ルート（`~/.cursor/`, `~/.claude/`, `~/.config/opencode/`, `tools/chezmoi/dot_claude/`, `tools/chezmoi/dot_config/opencode/`）配下への直接編集を deny します。canonical である `tools/chezmoi/dot_cursor/` への編集は許可されます。

- `~/.cursor/hooks.json` の `preToolUse` matcher → Cursor 用エントリ
- `~/.claude/settings.json` の `PreToolUse` matcher → Claude Code 用エントリ
- `~/.config/opencode/plugins/cursor-hook-bridge.ts` → OpenCode の `tool.execute.before` プラグイン

`mt chezmoi install-hook` で `chezmoi apply` + 旧 `~/.claude/hooks/agent-hooks/` 配下のクリーンアップを冪等に実行します。`mt chezmoi uninstall-hook` は chezmoi source 内の platform hook 設定を無効化する手順を案内します。

### OpenCode × cmux 統合

`chezmoi/dot_config/opencode/plugins/cmux-notify.ts` は opencode のプラグインで、opencode のセッション状態変化を cmux に通知し、サイドバータブに status バッジを出します。

購読イベント:
- `session.status` (`busy`) → ⚡️ 青色バッジ "Running" + 進捗インジケータ
- `session.status` (`retry`) → ↻ 橙色バッジ "Retrying"
- `session.status` (`idle`) → バッジクリア
- `session.idle` → バッジクリア + 通知 "Task complete"
- `session.error` → ❌ 赤色バッジ "Error" + 通知 "Error"
- `permission.updated` → 通知 "Waiting for input"

`mt chezmoi apply` で `~/.config/opencode/plugins/cmux-notify.ts` へデプロイされ、opencode 起動時に自動ロードされます。`cmux` バイナリが PATH にない場合は no-op で安全（クラッシュしません）。

必要要件:
- [cmux](https://cmux.app/) をインストールし PATH へ追加（`export PATH="/Applications/cmux.app/Contents/MacOS:$PATH"`）
- `mt chezmoi apply` を 1 回実行

通知挙動をカスタマイズしたい場合は `chezmoi/dot_config/opencode/plugins/cmux-notify.ts` を編集して `mt chezmoi apply` で反映してください。`~/.config/opencode/plugins/` 配下を直接編集すると platform-native hook によってブロックされます。

### secrets の暗号化

`chezmoi/dot_zsh_secrets.age` のような age 暗号化ファイルで API キーなどの secrets を管理できます。テンプレート側で `{{ include "dot_zsh_secrets.age" | decrypt }}` と書くと復号結果が展開されます。

## Tool Management

このリポジトリでは `manifests/Brewfile`、`manifests/mise.toml`、`manifests/npm-global.yml` を PC ツール管理の Single Source of Truth として扱います。
初回のみ、mise が repo の設定を読み込めるように trust します。

```bash
mise trust manifests/mise.toml
```

ローカル環境を manifest に合わせるには次を実行します。

```bash
mt tool install
```

`mt tool install` は manifest に書かれたツールをインストールした後、`Brewfile` 管理対象外の依存、未使用の mise tool version、`npm-global.yml` 管理対象外の npm global package を表示します。
削除候補がある場合は確認プロンプトを出し、承認したときだけ削除します。

`npm-global.yml` は npm global package の存在を管理します。
package が CLI binary を提供しない場合、package はインストールされても同名コマンドとして使えるとは限りません。

管理状態を確認するには次を実行します。

```bash
mt tool verify
```

`mt tool verify` は Homebrew の outdated 状態は失敗扱いにせず、manifest に書かれたパッケージが入っているかを確認します。
mise は `mise install --dry-run-code` で、`manifests/mise.toml` に書かれたツールが未インストールなら失敗します。
npm global は `manifests/npm-global.yml` に書かれたパッケージが未インストールなら失敗します。
verify は確認だけを行い、不足しているツールのインストールは行いません。

Homebrew でインストール済みのパッケージを最新化するには次を実行します。

```bash
mt tool brew upgrade
```

`mt tool brew upgrade` は Homebrew のみを対象にし、mise のバージョンは自動更新しません。
mise のツールバージョンを変える場合は `manifests/mise.toml` を編集してから `mt tool install` / `mt tool verify` を実行します。
npm global package を変える場合は `manifests/npm-global.yml` を編集します。

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

## Raycast Settings Backup

Raycast の設定（Export 11 カテゴリ: Settings / Snippets / Quicklinks / Notes / MCP Servers / Extensions / Hotkeys / AI Chats 等）を chezmoi 経由でバックアップ・リストアします。

### 初回セットアップ

1. Raycast アプリをインストール（`brew install --cask raycast`）
2. age 秘密鍵を生成（既存の chezmoi セットアップ時に生成済み）:
   `age-keygen -o ~/.config/chezmoi/key.txt`
3. passphrase（8 文字以上）を決めて暗号化:

   ```bash
   printf 'your-passphrase-here' | age -r <公開鍵> -o ~/src/tools/chezmoi/dot_raycast_passphrase.age
   ```

   （公開鍵は `age-keygen -y ~/.config/chezmoi/key.txt` で確認）

### 使い方

```bash
# Raycast 設定をエクスポートし、chezmoi 管理下に保存
mt raycast sync

# バックアップをコミット（暗号化済み .rayconfig が保存される）
cd ~/src/tools
git add chezmoi/dot_Raycast.rayconfig
git commit -m "backup: Raycast settings"
git push

# 別の Mac で復元
mt raycast restore
```

### 管理ファイル

| ファイル | 種別 | 役割 |
| --- | --- | --- |
| `chezmoi/dot_Raycast.rayconfig` | Raycast 暗号化 | Export 11 カテゴリ全データ（passphrase で暗号化、git 追跡） |
| `chezmoi/dot_raycast_passphrase.age` | age 暗号化 | Raycast 暗号化 passphrase（age 公開鍵で暗号化、git 追跡） |



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
  cli/          # self_cmd (install), launcher, style utilities
  git/          # GitHub repository operations
  opencode/     # OAuth setup, ngrok expose/stop
  tool.rs       # Homebrew and mise tool management
  agent_config/ # Cursor/Claude/OpenCode config sync
  vector/       # Markdown ベクトル検索（config / chunk / embed / qdrant / ingest / search）
  raycast/      # Raycast 設定バックアップ（sync / restore / shared）
  main.rs       # Entry point with clap subcommands
agent-configs/  # AI agent configs (Source of Truth)
  agents/       # SubAgent definitions
  skills/       # Skill definitions
  opencode/     # opencode 固有ファイル（plugins/ など）
  AGENTS.md     # Core rules (synced to CLAUDE.md, etc.)
chezmoi/        # chezmoi ソース（dotfile の Source of Truth）
  dot_zshrc.tmpl        # ~/.zshrc のテンプレート
  dot_zprofile          # ~/.zprofile の plain コピー
  dot_gitconfig         # ~/.gitconfig の plain コピー
  dot_zsh_secrets.age   # age 暗号化 API キー
  .chezmoiignore        # README.md を chezmoi apply から除外
  README.md             # ソースディレクトリの説明
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
