---
name: mt-propose-quality
description: 対象 repo のコード品質を SubAgent オーケストレーションで分析し、Quality 軸（既存の質の向上）の企画候補を発掘する。ユーザーが選んだ候補を最小構成の draft Issue として起票する。「mt-propose-quality」「品質企画」「品質改善の種まき」などと言われた時に使用する。
---

# mt-propose-quality

対象 repo のコード品質を分析し、Quality 軸（既存の質の向上）の企画候補を発掘して、ユーザーが選んだ候補を最小構成の draft Issue として起票する。

## 実行

`tado-run` を `--workflow ~/.config/opencode/skills/mt-propose-quality/workflow.ts` で起動する。
