---
name: mt-plan
description: Cursor Plan モードに依存せず、GitHub Issue ベースの計画作成から実行までを進める統合入口。ユーザーが「mt-plan」「計画を作って進める」「計画作成から実行まで」などを入力した時に使用する。
---

# mt-plan

GitHub Issue ベースの計画作成から実行までを扱う統合スキルです。入力に応じて `mt-create-plan`（計画作成）または `mt-run-plan`（計画実行）にルーティングします。

## ワークフローエンジン

mt-run-plan は `mt-workflow` エンジンで手順が管理されています。ワークフロー定義は `mt-plan/workflow.ts` を参照。

## 🚦 Plan First ルール

ファイル編集・状態遷移・外部副作用のあるコマンドは、以下を満たしてから行う:

1. 実行対象の計画 Issue が `refined` または `in-progress` として存在する
2. ユーザーがその計画の実行を明示している
3. これから行う作業が承認済み計画の範囲内である
4. Sub Issue を持つ親計画ではなく、実行可能な子計画または単一計画である

「改善案 N で良い」「この方針で良い」だけでは実行承認とみなさない。

## 🏃 ルーティング

| 入力 | 委譲先 |
| ---- | ---- |
| 新規計画の目的・背景がある、`draft` の計画 Issue 指定 | `mt-create-plan` |
| `refined` / `in-progress` の計画 Issue 指定 | `mt-run-plan`（エンジン起動） |
| 入力が曖昧 | 本文で選択肢を提示して確認 |

## エンジン起動（mt-run-plan 委譲時）

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow ~/.config/opencode/skills/mt-plan/workflow.ts
```

## ✅ 完了条件

- 計画作成後に実行へ進むか確認する Human Gate がある
- 実行可能な計画だけが mt-run-plan に渡される
- 状態遷移は `transition-plan.ts` 経由で行われる
- 分解計画は GitHub Sub Issue の 1 階層関係で管理され、親は状態集約だけを担う（詳細は `plan-format.md` の分解計画セクションを参照）

## 📦 アウトプット

- 作成・更新された計画 Issue (GitHub URL)
- 実行された計画 Issue の `## 🐢 履歴` 更新

## ⚠️ 注意事項

- 計画フォーマット本文は重複させない（`plan-format.md` を Source of Truth とする）
- 状態遷移は `transition-plan.ts` 経由で行い、`gh project item-edit` を直接使わない
- `draft` の計画は実行せず、先に `mt-create-plan` で整理する
- Sub Issue を持つ親計画は実行せず、子計画を `mt-run-plan` に渡す
- `~/.config/mt-plan/config.json` が未設定の場合は `mt-plan init` を案内する
