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
| `mt git repo create`           | GitHub リポジトリを対話的に作成        |
| `mt git repo select`           | ~/doc, ~/src から Git リポジトリを選択してパスを出力 |
| `mt git worktree select`       | Git worktree を選択してパスを出力      |
| `mt opencode oauth setup`      | Google OAuth のセットアップ            |
| `mt opencode web expose`       | OpenCode Web を ngrok で公開           |
| `mt opencode web stop`         | OpenCode Web の公開を停止              |
| `mt tool install`              | manifest からツールをインストール      |
| `mt tool verify`               | Homebrew、mise、npm global の管理状態を検証 |
| `mt tool brew upgrade`         | Homebrew パッケージを更新              |

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

## SearXNG (ローカル検索エンジン)

`mt-search-web` / `mt-deep-research` Skill は、ローカルの SearXNG インスタンスをメタ検索エンジンとして利用する。

起動:

```bash
mise run docker-up
```

停止:

```bash
mise run docker-down
```

ログ確認:

```bash
mise run docker-logs
```

SearXNG は `localhost:8080` で JSON API を提供する。設定は `docker/searxng/settings.yml` で管理する。

## Project Structure

```
src/
  cli/          # self_cmd (install), launcher, style utilities
  git/          # GitHub repository operations
  opencode/     # OAuth setup, ngrok expose/stop
  tool.rs       # Homebrew and mise tool management
  agent_config/ # Cursor/Claude/OpenCode config sync
  main.rs       # Entry point with clap subcommands
agent-configs/  # AI agent configs (Source of Truth)
  agents/       # SubAgent definitions
  skills/       # Skill definitions
  opencode/     # opencode 固有ファイル（plugins/ など）
  AGENTS.md     # Core rules (synced to CLAUDE.md, etc.)
docker/         # Docker Compose services
  searxng/      # SearXNG settings
manifests/      # Homebrew, mise, npm global manifests
```

## Development

```bash
cargo fmt           # Format code
cargo clippy        # Lint
cargo test          # Run tests
cargo build         # Build
```
