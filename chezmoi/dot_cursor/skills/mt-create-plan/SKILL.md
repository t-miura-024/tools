---
name: mt-create-plan
description: Cursor Plan モードに依存せず、GitHub Issue として計画ファイルを新規作成・リファインメントする。from-Issue フロー (既存 Issue を plan 化) もサポート。ユーザーが「mt-create-plan」「計画作成」「計画を具体化」などを入力した時に使用する。
---

# mt-create-plan

ワークフローエンジン（`mt-workflow`）で計画作成・リファインメントの手順を管理する。実行は `mt-run-plan` の責務。

## エンジン起動

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow ~/.config/opencode/skills/mt-create-plan/workflow.ts
```

`init` 後は `next`（次のステップのプロンプト取得）→ ステップ実行 → `report`（結果報告）のサイクルで進行する。

```bash
# 次のステップのプロンプトを取得
bun run ~/.config/opencode/skills/mt-workflow/cli.ts next --session <id>

# ステップ完了を報告（stdin から JSON）
echo '{"stepKey":"...","status":"completed","subagentOutput":"..."}' | \
  bun run ~/.config/opencode/skills/mt-workflow/cli.ts report --session <id>

# 状態確認
bun run ~/.config/opencode/skills/mt-workflow/cli.ts status --session <id>
```

## ワークフロー定義

`mt-create-plan/workflow.ts` 参照。ステップ順:

| Step | Key | Type | 内容 |
|------|-----|------|------|
| 1 | `grill` | task | Grill Phase。from-Issue 確認、質問（一度に 1 つ）、最終本文確定 → `issue-body.md` |
| 2 | `prepare` | task | 起票準備。repo 決定、label 確認・自動作成、分解要否判定 → `prepare-decision.json` |
| 3 | `decompose_gate` | human_gate | 分解判定・起票承認。revise→grill |
| 4 | `update_issue` | task | Issue 作成・更新（condition で分解しない場合）。from-Issue は既存 Issue を更新 |
| 5 | `create_sub_issues` | task | Sub Issue 作成（condition で分解する場合）。親子 1 階層 |
| 6 | `refined_gate` | human_gate | refined 昇格確認。revise→grill / abort→draft のまま |
| 7 | `finalize` | task | refined 昇格（`transition-plan.ts`）、作成内容報告 |

`update_issue` と `create_sub_issues` は `prepare-decision.json` に基づく condition で相互排他的にスキップされる。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下:

- `plan-format.md` — Issue body フォーマット（分解計画制約の詳細含む）
- `list-plans.ts` — 既存計画 Issue の一覧取得
- `transition-plan.ts` — ステータス遷移（GitHub Project Status 更新 + Issue open/closed 同期）
- `init-config.ts` — 設定読み込み

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## ✅ 完了条件

- 計画 Issue が `plan-format.md` に従って作成されている
- `kind/plan` label が付与されている
- Project に追加され、Status が適切に設定されている
- ユーザーが Issue 内容を承認し、作成時に refined 昇格の要否が決定されている
- 分解時は GitHub Sub Issue 関係が 1 階層であり、子計画が親計画の目的・スコープを過不足なく満たしている

## ⚠️ 注意事項

- 手順はワークフローエンジンで管理する。SKILL.md を直読みして `gh issue create` 等を直接実行せず、必ずエンジンを起動する
- Issue の作成・更新はワークフロー経由で行う（直接 `gh issue create` をしない）
- `draft` の Issue を `mt-run-plan` で実行させない
- `kind/plan` label の自動作成は冪等に行う
- 子計画の作成や refined への昇格は、作成承認ゲートでユーザーの明示的な承認を得てから行う
