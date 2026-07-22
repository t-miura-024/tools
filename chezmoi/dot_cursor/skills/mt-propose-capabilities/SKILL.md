---
name: mt-propose-capabilities
description: 対象 repo を軽量走査して Capability 軸（新しい能力の獲得）の企画候補を SubAgent オーケストレーションで発掘し、ユーザーが選んだ候補を最小構成の draft Issue として起票する。企画の発掘・種まき、capability 提案、アイデア出しと言われた時に使用する。
---

# mt-propose-capabilities

対象 repo の軽量走査から Capability 軸（新しい能力の獲得）の企画候補を SubAgent オーケストレーションで発掘し、ユーザーの選択を経て draft Issue として起票する。企画の発掘に終始し、起票後の具体化（完了条件・方針・実行単位の策定）は `mt-create-plan` の from-Issue フローに委譲する。

## エンジン起動

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow ~/.config/opencode/skills/mt-propose-capabilities/workflow.ts
```

`init` 後は `next`（次のステップのプロンプト取得）→ ステップ実行 → `report`（結果報告）のサイクルで進行する。

## ワークフロー定義

`mt-propose-capabilities/workflow.ts` 参照。ステップ順:

| Step | Key | Type | 内容 |
|------|-----|------|------|
| 1 | `brainstorm` | task | 3 SubAgent 並列（走査 + 各 5 案 = 15 案） |
| 2 | `dedup_check` | task | 既存 Issue との重複チェック・除外 |
| 3 | `review_score` | task | 3 レビュアー並列（観点ごと × 15 案、1〜5 点） |
| 4 | `present_gate` | human_gate | 上位 5 案を提示、ユーザー選択 |
| 5 | `create_drafts` | task | 選択候補を draft Issue 起票 |
| 6 | `confirm_done` | human_gate | 完了確認 |

## ブレスト SubAgent の視点

| SubAgent | 視点 |
|----------|------|
| 1 | ユーザー体験向上 |
| 2 | 開発効率向上 |
| 3 | エコシステム拡張 |

## レビュー観点

| 観点 | 定義 |
|------|------|
| インパクト | その能力が日常のワークフローをどれだけ変えるか。頻度 × 効果の大きさ |
| 実現可能性 | 既存の技術・依存・スキルで現実的に実装できるか。未知の技術リスクがないか |
| 優位性 | 既存ツールや他のスキルに対する優位があるか。この repo に置く必然性があるか |

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `list-plans.ts` — 既存計画 Issue の一覧取得（重複チェックに使用）
- `init-config.ts` — 設定読み込み

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## ⚠️ 注意事項

- 企画の具体化（完了条件・方針・実行単位の策定）はこの Skill の責務ではない。`mt-create-plan` に委譲する
- 走査は読み取り専用で行い、repo のファイルを変更しない
- ユーザーの選択前に Issue を起票しない（Human Gate 必須）
- 重複チェックは毎回実行する。定期実行でノイズが増えないようにする
- `kind/plan` label の自動作成は冪等に行う（色: 0E8A16）
- draft Issue の本文はタイトル + 💭 背景の最小構成（根拠を背景に織り込む）
