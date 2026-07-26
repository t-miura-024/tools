---
name: mt-deep-research
description: ローカル SearXNG、curl、pandoc、jq を使い、Planner / Researcher / Writer / Reviewer / Auditor の SubAgent オーケストレーションで自律的な多段探索（Deep Research）を行う。Researcher は問いごと、Reviewer は観点ごとに並列化する。中間生成物は SQLite（research.db）に保存し、人間が読むのは plan.md と report.md のみ。各フェーズ・サイクル後に監査 SubAgent を実行し、plan.md / report.md 作成時は lint + mermaid 構文チェックを通す。
---

# mt-deep-research

ローカル SearXNG と SubAgent オーケストレーションで自律的な多段探索（Deep Research）を行う。中間生成物は SQLite に保存し、人間が読むのは plan.md と report.md のみ。

## 実行

`mt-run-workflow` を `--workflow ~/.config/opencode/skills/mt-deep-research/workflow.ts` で起動する。
