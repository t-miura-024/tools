---
status: superseded by ADR-0013
---

# standalone レビュー終了用に mt difit done を新設

`mt difit check` はゲート判定コマンドであり、通過時のみサーバを kill する。standalone mt-review-diff にはゲート/自動修正ループが不要だが、difit サーバは必ず停止する必要がある。そこで check と同じ `{passes, blocking_threads}` スキーマを出力しつつ、通過/ブロックに関係なく必ずサーバ kill + 状態削除 + exit 0 で終了する `mt difit done` を新設する。これにより check のゲート語義が純粋に保たれ、standalone と workflow で終了コマンドが明確に分かれる。
