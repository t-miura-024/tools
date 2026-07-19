---
status: accepted
---

# agent-configs/ の廃止と chezmoi 統合

`agent-configs/` ディレクトリおよび `mt agent-config` サブコマンドを廃止し、AI agent 設定を `chezmoi/dot_cursor/` 経由で管理する方式に統合した。

## Context

- 旧構成では AI agent 設定の Source of Truth が `agent-configs/` ディレクトリにあり、`mt agent-config` サブコマンドで管理していた
- Phase 2 で chezmoi を導入し、`chezmoi/dot_cursor/` を canonical とする新構成へ移行した
- 移行後は `agent-configs/` が不要になり、`agent_config/` Rust モジュールも `agent/` に改名・再構成された

## Decision

- `agent-configs/` ディレクトリを削除
- `mt agent-config` サブコマンドを削除し、`mt agent sync` に置き換え
- Rust モジュール `agent_config/` を `agent/` に改名し、chezmoi 統合後の構成に合わせて再実装
- 設定の同期は `mt agent sync` で行い、`dot_cursor/` → `dot_claude/` + `dot_config/opencode/` への一方向変換とする
- `mt chezmoi doctor` は `agent-configs/` ディレクトリの削除を確認する

## Consequences

- 設定の管理場所が `chezmoi/dot_cursor/` に一本化された
- `agent/` モジュールは chezmoi 経由の設定管理を前提とした責務へ変更された
- `agent-configs/` 廃止は ADR 0002 の canonical ルールと一体で運用される
- 旧パスの参照が残っていないことは `mt chezmoi doctor` が検証する
