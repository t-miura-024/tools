# Cursor 設定作成系 Skill 共通フロー

`mt-create-rule` / `mt-create-skill` / `mt-create-subagent` が共有する対話・委譲・レビューの流れです。各 Skill には種別固有の判断・フィールド収集だけを置き、共通手順はこのファイルを参照します。

## 1. 要求・要件分析

ユーザーとの対話で以下を把握する:

- 何を実現したいか
- なぜ必要か
- どんな場面で使うか

会話コンテキストから推論できる情報はそのまま活用し、冗長な質問を避ける。

## 2. 配置先確認

本文で配置先の選択肢を番号付きで提示して確認する:

- プロジェクトレベル: 特定プロジェクト固有の定義
- ユーザーレベル: 全プロジェクト共通の定義

## 3. Creator SubAgent への委譲

`mt-cursor-config-creator` SubAgent に `mode`、`type`、`template_path`、`output_path`、`fields` を渡し、定義ファイルの作成・修正を委譲する。

Creator SubAgent はテンプレートを読み込み、コメントを削除し、`fields` の値で frontmatter と本文を構成する。不足情報がある場合は補完せず、親エージェントに返却する。

## 4. レビュー・改善ループ

`mt-review-cursor-config` Skill（`_cursor_user/skills/mt-review-cursor-config/SKILL.md`）のフローに従ってレビューし、品質を確保する。

1. `mt-review-cursor-config` Skill の対象特定と SubAgent へ委譲し、レビュー結果を受け取る
2. `🔴 Must Fix` / `🟡 Should Fix` がある場合、`mt-cursor-config-creator` SubAgent に feedback を渡して修正を委譲する
3. 修正後、`mt-cursor-config-reviewer` に再レビューを依頼する
4. `🔴 Must Fix` / `🟡 Should Fix` がゼロになったらループ終了

安全弁として最大 3 回で止め、超過時はユーザーに状況を報告して判断を仰ぐ。

## 5. Nice to Have の確認

レビューループ中に蓄積された `🟢 Nice to Have` をユーザーに提示し、対応するかスキップするかを本文で確認する。

対応する場合は Creator SubAgent に修正を委譲する。この修正は再レビューしない。

## 6. 同期案内

配置先の変更は commit で post-commit git hook が自動同期する。即時反映したい場合は以下を案内する:

- プロジェクトレベル（`_cursor/`）: `npm run sync:cursor:project`（または `bun scripts/cursor-sync/sync.ts`）
- ユーザーレベル（`_cursor_user/`）: `npm run sync:cursor:user`（または `bun scripts/cursor-user-sync/sync.ts`）
