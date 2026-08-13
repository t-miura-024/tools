---
status: superseded by ADR-0013
---

# should/want 指摘の taxonomy を [question] に統一

agent-review.json の should/want を difit に注入する際、`[context]` は「解説」であり「指摘」ではない。指摘と解説は本質的に異なるため、should/want 両方を `[question]`（AI が人間に判断を仰ぐ）に統一し、重大度は body 内に `(should)` / `(want)` として記載する。`[context]` は executor の補足専用とする。これにより taxonomy の意味的整合性が保たれ、gate_passes() は `[context]` のみ通過させるので `[question]` は常に人間の確認を要求する。
