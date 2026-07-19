---
status: accepted
---

# manifests/ を PC ツール管理の Single Source of Truth とする

PC にインストールする開発ツールは `manifests/Brewfile`、`manifests/mise.toml`、`manifests/bun-global.yml` を Single Source of Truth とし、`mt tool install` で一括インストールする。ツールの直接インストールや手動バージョン変更は行わない。

## Context

- Homebrew で管理する CLI ツール・cask アプリは `manifests/Brewfile` に宣言する
- mise で管理するランタイム（bun, node, rust）は `manifests/mise.toml` に宣言する
- bun global で管理するパッケージは `manifests/bun-global.yml` に宣言する
- `mt tool install` はこれら 3 つの manifest に基づいてツールをインストールし、manifest 管理対象外の依存を報告する
- `mt tool install` 実行前に `mise trust manifests/mise.toml` が必要（初回のみ）

## Decision

- `manifests/Brewfile` — Homebrew パッケージ・cask・VSCode 拡張の宣言。Homebrew で配布されていないツールは `cargo "mt"` のように cargo install を宣言
- `manifests/mise.toml` — mise 管理のランタイムバージョン宣言（`[tools]` セクション）
- `manifests/bun-global.yml` — bun global パッケージの存在管理（version: latest で最新を追従）
- ツールの追加・削除・バージョン変更は必ず manifest を編集し、`mt tool install` で反映する
- 検証は `mt tool verify` で行う（不足ツールをインストールせず報告のみ）
- Homebrew の一斉更新は `mt tool brew upgrade` で行う（mise の自動更新はしない）

## Consequences

- 別 PC での環境再現が `mt tool install` 一発で完了する
- manifest が唯一の宣言源となり、手動インストールによる環境乖離が発生しない
- `mt tool verify` で CI や定期的な健全性チェックが可能
- バージョン固定が必要なランタイムは mise で明示し、追従パッケージは bun global で latest 指定する
