---
status: accepted
---

# mt-grill-me の廃止

`mt-grill-me`（一問一答の手動専用ヒアリング、`disable-model-invocation: true`）を廃止し、汎用ヒアリングは `mt-grill-rounds` に一本化する。

## Context

- `mt-grill-me` は Matt Pocock の `grill-me` / `grilling` を統合した一問一答 Skill で、ADR 0001 で `mt-grill-me` へ統合、ADR 0010 でラウンド制（`mt-grill-rounds`）と分離しつつ手動専用として存置された。
- `mt-grill-rounds` はラウンド制・フロンティア・SubAgent による非ブロッキング事実調査・ライブ地図（`grill-map.md`）育成を備え、汎用トリガー（`grill` / `徹底ヒアリング` / `設計インタビュー`）のメインに据えられていた。
- 一問一答とラウンド制は提示単位が根本的に異なるが、`mt-grill-rounds` でもフロンティアが 1 問のラウンドとして一問一答の運用を包含できる。手動専用の独立 Skill を残すことでカタログの重複・混線（トリガー競合・責務境界の曖昧さ）が生じる。
- `mt-grill-me` は `disable-model-invocation: true` のため自動起動せず、実害は小さいが、canonical に残すことで派生 symlink の維持コストと ADR 前提の矛盾を生む。

## Decision

- `chezmoi/dot_cursor/skills/mt-grill-me/SKILL.md` を削除する。
- 派生側の symlink を削除する:
  - `chezmoi/dot_claude/skills/symlink_mt-grill-me`
  - `chezmoi/dot_config/opencode/skills/symlink_mt-grill-me`
- `mt-grill-me` の代替は `mt-grill-rounds` とする。1 問ずつ深掘りしたい場面でも `mt-grill-rounds` を使用し、フロンティア 1 問のラウンドとして運用する。
- ADR 0010 の「`mt-grill-me` は手動専用として存置」の方針を撤回し、同 ADR の `status` を `superseded` に遷移させる。
- ADR 0001 の分類表（`grill-me` / `grilling` → `mt-grill-me`）は歴史的記録として残し、廃止注記を追記する。

## Consequences

- `mt agent sync --check` / `mt chezmoi doctor` の drift が解消される。
- `mt chezmoi apply` 時に `chezmoi/.chezmoiremove.tmpl` によりホーム側（`~/.cursor/skills/mt-grill-me` 等）の残留も自動削除される。
- `grill me` トリガーは廃止。以後は `grill` / `mt-grill-rounds` / `徹底ヒアリング` を使用する。
- 後方互換レイヤー・フォールバックは設けない。
