---
name: mt-propose-quality
description: 対象 repo のコード品質を SubAgent オーケストレーションで分析し、Quality 軸（既存の質の向上）の企画候補を発掘する。ユーザーが選んだ候補を最小構成の draft Issue として起票する。「mt-propose-quality」「品質企画」「品質改善の種まき」などと言われた時に使用する。
---

# mt-propose-quality

対象 repo のコード品質を SubAgent オーケストレーションで走査・分析し、Quality 軸（既存の質の向上）の企画候補を発掘する。ユーザーが選択した候補を最小構成の draft Issue として起票する。

企画の具体化（完了条件・方針・実行単位の策定）は `mt-create-plan` の from-Issue フローに委譲する。

## エンジン起動

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow ~/.config/opencode/skills/mt-propose-quality/workflow.ts
```

`init` 後は `next`（次のステップのプロンプト取得）→ ステップ実行 → `report`（結果報告）のサイクルで進行する。

## ワークフロー定義

`mt-propose-quality/workflow.ts` 参照。ステップ順:

| Step | Key | Type | 内容 |
|------|-----|------|------|
| 1 | `brainstorm` | task | 3 SubAgent 並列（品質分析 + 各 5 案 = 15 案） |
| 2 | `dedup_check` | task | 既存 Issue との重複チェック・除外 |
| 3 | `review_score` | task | 3 レビュアー並列（観点ごと × 15 案、1〜5 点） |
| 4 | `present_gate` | human_gate | 上位 5 案を提示、ユーザー選択 |
| 5 | `create_drafts` | task | 選択候補を draft Issue 起票 |
| 6 | `confirm_done` | human_gate | 完了確認 |

## ブレスト SubAgent の視点

| SubAgent | 視点 |
|----------|------|
| 1 | コードの健全性 |
| 2 | テスト・検証の充実 |
| 3 | ドキュメント・保守性 |

## レビュー観点

| 観点 | 定義 |
|------|------|
| 深刻度 | 放置した場合のリスク。バグ・パニック・データ損失・保守不能化の可能性 |
| 修正容易性 | 少ない変更で改善できるか。大規模リファクタなしで着手できるか |
| 波及効果 | その修正が他の改善の前提になるか。直すことで連鎖的に良くなるか |

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `list-plans.ts` — 既存計画 Issue の一覧取得（重複チェックに使用）
- `init-config.ts` — 設定読み込み

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## ⚠️ 注意事項

- 企画の具体化（完了条件・方針・実行単位の策定）はこのスキルの責務ではない。`mt-create-plan` に委譲する
- 走査は読み取り専用で行い、repo のファイルを変更しない
- ユーザーの選択前に Issue を起票しない（Human Gate 必須）
- 重複チェックは毎回実施する。定期実行でノイズが増えないようにする
- アーキテクチャ深化の重いテーマは `mt-improve-codebase-architecture` への連携を背景に注記する
- `kind/plan` label の自動作成は冪等に行う（色: 0E8A16）
- draft Issue の本文はタイトル + 💭 背景の最小構成（根拠を背景に織り込む）
