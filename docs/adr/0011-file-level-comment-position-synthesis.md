---
status: superseded by ADR-0013
---

# ファイルレベル指摘の position 合成

difit の comment import スキーマは position（side + line）を必須としており（5.0.8 の normalizeCommentImportEntry）、ファイルレベル指摘を表現できない。mt 側では position なしの import エントリに `{"side":"new","line":1}` を合成して difit に渡し、ファイル全体に紐づく指摘を表現する。合成位置がファイル先頭に誤誘導される副作用は許容し、上流 difit への提案は行わない。
