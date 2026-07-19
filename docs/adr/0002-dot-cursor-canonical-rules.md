---
status: accepted
---

# dot_cursor を canonical とする AI agent 設定管理

すべての AI agent 設定（Rule / Skill / SubAgent / Hook）は `chezmoi/dot_cursor/` を canonical（Source of Truth）とし、Claude Code および OpenCode 向けの派生設定は `mt agent sync` によって自動生成する。canonical 以外の配置先を直接編集してはならない。

## Context

- `tools` リポジトリでは AI agent 設定を chezmoi 経由でデプロイしており、Cursor / Claude / OpenCode の 3 platform を運用している
- `dot_cursor/agents/` と `dot_cursor/skills/` が canonical であり、`dot_claude/` と `dot_config/opencode/` は派生である
- 派生設定を直接編集すると `mt chezmoi apply` によるデプロイで上書きされ、変更が失われる
- platform-native hook は canonical への直接編集以外を deny しており、誤編集を防止する

## Decision

- `chezmoi/dot_cursor/agents/` — agent 定義の canonical（`name`, `description`, `readonly` 形式）
- `chezmoi/dot_cursor/skills/` — skill 定義の canonical
- `chezmoi/dot_cursor/hooks.json` — Cursor PreToolUse 設定の canonical
- `chezmoi/dot_claude/` および `chezmoi/dot_config/opencode/` は `mt agent sync` による生成先であり、直接編集禁止
- デプロイ先（`~/.cursor/`, `~/.claude/`, `~/.config/opencode/`）も直接編集禁止
- 編集は常に `chezmoi/dot_cursor/` で行い、`mt agent sync` → `mt chezmoi apply` で反映する

## Consequences

- 設定の一貫性が保証される
- 派生先での誤編集が自動検出される（`mt agent sync --check`）
- 設定変更のワークフローが統一される
- `tools/chezmoi/dot_cursor/` が変更の唯一の入口となる
