---
name: mt-create-plan
description: Cursor Plan モードに依存せず、GitHub Issue として計画ファイルを新規作成・リファインメントする。from-Issue フロー (既存 Issue を plan 化) もサポート。ユーザーが「mt-create-plan」「計画作成」「計画を具体化」などを入力した時に使用する。
---

# mt-create-plan

GitHub Issue ベースで計画作成・リファインメントを行う。実行は `mt-run-plan` の責務。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `plan-format.md` — Issue body の本文フォーマット
- `list-plans.ts` — 既存計画 Issue の一覧取得
- `transition-plan.ts` — ステータス遷移
- `init-config.ts` — 設定読み込み
- `workflow.ts` — mt-run-plan 実行時のワークフロー定義

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## 🏃 ステップ

### 1. Grill Phase

計画の全側面について共通認識に達するまで質問を繰り返す。

- **ユーザー決定領域:** 背景、why、意図、制約 — 推測で埋めず質問で確認
- **AI 提案領域:** 完了条件、アウトプット、方針、解決策 — 選択肢・推奨度・理由を添えて提案

質問は一度に1つ。ユーザーが「十分」と宣言するまで継続。

#### from-Issue フロー

開始前に「既存 Issue を取り込みますか？」と確認。Yes の場合は Issue メタデータ取得後、通常の Grill Phase へ。

### 2. 対象 repo の決定

1. `gh repo view --json nameWithOwner` で repo を確認
2. owner が `t-miura-024` → そのまま。それ以外 → `t-miura-024/note` + `external/<repo>` label

### 3. label の確認・自動作成

`kind/plan` label がなければ自動作成。`external/<repo>` label も同様。

### 4. 計画 Issue の作成

`plan-format.md` に従い Issue body を組み立て、`gh issue create` で作成。Project に追加し Status を `draft` に設定。

### 5. 作成内容の報告

Issue URL、repo、Project、Status、label を報告。次ステップ（refined 昇格）を案内。

### 6. Refined 昇格

ユーザー承認後:

```bash
bun <mt-plan-dir>/transition-plan.ts <number> refined
```

不足があれば `draft` のまま残し、次回確認事項を明記。

## ✅ 完了条件

- 計画 Issue が `plan-format.md` に従って作成されている
- `kind/plan` label が付与されている
- Project に追加され、Status が適切に設定されている
- ユーザーが Issue 内容を承認している

## ⚠️ 注意事項

- 直接 `gh issue create` をせず、本 Skill 経由で作成する
- `draft` の Issue を `mt-run-plan` で実行させない
- `kind/plan` label の自動作成は冪等に行う
