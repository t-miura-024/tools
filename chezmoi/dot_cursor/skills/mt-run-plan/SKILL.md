---
name: mt-run-plan
description: >
  Cursor Plan モードに依存せず、GitHub Issue ベースの計画を選び、方針に基づき実行し履歴を更新する。
  ユーザーが「mt-run-plan」「計画を進める」などを入力した時に使う。
---

# mt-run-plan

GitHub Issue ベースの計画を選び、方針に基づき実行し履歴を更新する。計画の新規作成・リファインメントは扱わない。

## 実行

`tado-run` を `--workflow ~/.config/opencode/skills/mt-plan/workflow.ts` で起動する。
