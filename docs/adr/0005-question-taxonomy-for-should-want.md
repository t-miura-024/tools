---
status: superseded by ADR-0013; partially re-adopted by ADR-0026
---

# should/want 指摘の taxonomy を [question] に統一

agent-review.json の should/want を difit に注入する際、`[context]` は「解説」であり「指摘」ではない。指摘と解説は本質的に異なるため、should/want 両方を `[question]`（AI が人間に判断を仰ぐ）に統一し、重大度は body 内に `(should)` / `(want)` として記載する。`[context]` は executor の補足専用とする。これにより taxonomy の意味的整合性が保たれ、gate_passes() は `[context]` のみ通過させるので `[question]` は常に人間の確認を要求する。

## 再採用範囲（ADR-0026）

ADR-0026 により、`[context]` を「解説であり指摘ではない」ノンブロッキング分類として認識する部分と、指摘の性質を taxonomy で区別する枠組みが一部再採用された。ただし重大度の body 表記は `(should)` / `(want)` ではなく GFM Markdown の絵文字 severity（`🚨 must` / `⚠️ should` / `💡 want`、例: `**⚠️ should · 🙋 question · 🎯 req-1**`）に置き換わり、taxonomy も `[question]` 統一ではなく `🐛 issue`（AI 発見の問題点）/ `🙋 question`（AI が人間に判断を仰ぐ）の 2 分類に拡張された。旧形式の先頭プレフィックス（`[issue]` / `[question]` / `[context]`）は読み取り互換のみ残る。
