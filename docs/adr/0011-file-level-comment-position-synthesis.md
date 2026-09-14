---
status: superseded by ADR-0013; partially re-adopted by ADR-0026
---

# ファイルレベル指摘の position 合成

difit の comment import スキーマは position（side + line）を必須としており（5.0.8 の normalizeCommentImportEntry）、ファイルレベル指摘を表現できない。mt 側では position なしの import エントリに `{"side":"new","line":1}` を合成して difit に渡し、ファイル全体に紐づく指摘を表現する。合成位置がファイル先頭に誤誘導される副作用は許容し、上流 difit への提案は行わない。

## 再採用範囲（ADR-0026）

ADR-0026 により、`mt difit start` の stdin 直 import（stdin コメント、および stale 復旧・difit 引数変更時の保存済みコメント再注入）に限り再採用された。mt-review-diff の findings 経由は position 必須（ADR-0022）で、position なしは convert 時に機械的に除外され、合成は発生しない。
