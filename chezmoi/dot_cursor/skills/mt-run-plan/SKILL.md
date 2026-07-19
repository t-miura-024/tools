---
name: mt-run-plan
description: >
  Cursor Plan モードに依存せず、GitHub Issue ベースの計画を選び、方針に基づき実行し履歴を更新する。
  ユーザーが「mt-run-plan」「計画を進める」などを入力した時に使う。
---

# mt-run-plan

ワークフローエンジン（`mt-workflow`）で計画実行の手順を管理する。計画の新規作成・リファインメントは扱わず、方針に基づく実行、履歴更新、完了処理に責務を限定する。

## 🚦 Plan First ルール

この Skill は承認済み計画の実行だけを扱う。以下を満たせない場合は実行せず、`mt-create-plan` で計画修正・再承認へ戻す:

1. 実行対象の計画 Issue が `refined` または `in-progress` として存在する
2. ユーザーがその計画の実行を明示している
3. これから行う作業が承認済み計画の範囲内である
4. 実行対象が Sub Issue を持たない子計画または単一計画である

「改善案 N で良い」「この方針で良い」だけでは実行承認とみなさない。

## 実装を含む計画の進め方

- 可能な範囲で合意済み seam に対する TDD（Red → Green）を使う
- 変更中は typecheck と関連テストをこまめに走らせ、最後に広い検証を 1 回通す
- 実装完了後は `mt-review-diff` で差分レビューしてから Done 確認へ進む
- 仕様にない振る舞いは追加しない

## エンジン起動

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow ~/.config/opencode/skills/mt-plan/workflow.ts
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

`mt-plan/workflow.ts` 参照。ステップ順:

| Step | Key | Type | 内容 |
|------|-----|------|------|
| 1 | `identify_plan` | human_gate | 計画 Issue 番号の特定 |
| 2 | `start_execution` | task | Issue 検証、refined→in-progress 遷移、body 読み込み |
| 3 | `execute_work` | task | `## ✅ 完了条件`・`## 🧭 方針` に基づく作業実行 |
| 4 | `review_work` | task | 5軸レビュー、review-current.json 出力。must>0 なら auto-goto execute_work |
| 5 | `review_followups_gate` | human_gate | should/want の対応要否確認。revise→execute_work |
| 6 | `confirm_done` | human_gate | Done 確認 |
| 7 | `finalize_done` | task | in-progress→done 遷移（`transition-plan.ts`）、完了報告 |

## レビューループ

Step 4（`review_work`）は task 型で 5 軸レビューを実行し、結果を `review-current.json` に構造化保存する。

- `review_work.check()` が must 件数を機械的に判定する
- must > 0: エンジンが `execute_work` に戻す（review_work は pending に保持）
- must = 0: review_followups_gate に進む
- このループは must が 0 になるまで自動継続される

`review-current.json` の形式:

```json
{
  "round": 2,
  "axes": {
    "essentiality": [{"severity": "must", "detail": "..."}],
    "acceptance": [],
    "scope": [],
    "alignment": [],
    "quality": []
  },
  "counts": {"must": 1, "should": 2, "want": 1}
}
```

## 状態遷移

GitHub Project の Status 同期は各ステップ内で `transition-plan.ts` を呼び出して行う:

- `start_execution`: refined → in-progress
- `finalize_done`: in-progress → done

Sub Issue を持つ親計画は集約ノードであり、実行を拒否する。子計画を `transition-plan.ts` 経由で遷移すると、最初の子の `in-progress` で親も `in-progress` へ、全子の `done` で親も `done` へ自動集約する。GitHub UI から直接変更した状態は集約対象にしない。詳細は `plan-format.md` の分解計画セクションを参照。

集約判定と親更新の間に GitHub UI で並行して Status を変更しない。GitHub API は親 Status の条件付き更新を提供しないため、並行変更がある場合の親状態は保証対象外とする。

`ALLOWED_TRANSITIONS` は廃止され、遷移ルールはワークフローのステップ順序で定義される。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下:

- `transition-plan.ts` — 状態遷移（GitHub Project Status 更新 + Issue open/closed 同期）
- `list-plans.ts` — 計画一覧
- `plan-format.md` — Issue body フォーマット
- `workflow.ts` — ワークフロー定義
- `sync-sessions.ts` — workflow.db セッションと計画の同期レイヤ

## ✅ 完了条件

- 対象が `refined` か `in-progress` の Issue から選ばれている
- 親計画ではなく、実行可能な子計画または単一計画が選ばれている
- `## 🐿️ メモ`・`## 🐢 履歴` が実行状況に合っている
- 状態遷移は `transition-plan.ts` 経由である
- `done` 化は完了条件とユーザー合意のうえ
- 中断なら再開位置が Issue body に残っている

## ⚠️ 注意事項

- 新規作成・リファインは `mt-create-plan` の責務
- `draft` は先に `mt-create-plan` で扱う
- `tmp/plan/` 配下の旧形式 Markdown は履歴専用であり、実行対象にしない
- 状態遷移は `gh project item-edit` / `gh issue close` 直ではなく `transition-plan.ts` を使う
- ユーザー承認前に `done` 化しない
- 承認済み計画の範囲外に出る実行は行わない
