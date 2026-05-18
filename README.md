# mt

個人開発支援用の CLI ツール集（Rust）。

## Prerequisites

- Rust 1.85+ (edition 2024)
- 外部依存: `gh` (GitHub CLI), `ngrok`, `opencode`, `curl`, `ssh`

## Install

```bash
cargo install --path .
```

## Subcommands

| Command                        | Description                           |
| ------------------------------ | ------------------------------------- |
| `mt`                           | 対話型スクリプトセレクター            |
| `mt init`                      | mt コマンドの初期セットアップ          |
| `mt git repo create`           | GitHub リポジトリを対話的に作成        |
| `mt opencode oauth setup`      | Google OAuth のセットアップ            |
| `mt opencode web expose`       | OpenCode Web を ngrok で公開           |
| `mt opencode web stop`         | OpenCode Web の公開を停止              |

## Project Structure

```
src/
  cli/          # init, launcher, style utilities
  git/          # GitHub repository operations
  opencode/     # OAuth setup, ngrok expose/stop
  main.rs       # Entry point with clap subcommands
```

## Development

```bash
cargo fmt           # Format code
cargo clippy        # Lint
cargo test          # Run tests
cargo build         # Build
```
