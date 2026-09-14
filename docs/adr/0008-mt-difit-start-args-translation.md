---
status: superseded by ADR-0013; partially re-adopted by ADR-0026
---

# ADR-0008: mt difit start の引数変換によるコメント表示問題の根本解決

- Status: Accepted
- Date: 2026-08-01

## 背景

`mt difit start <base-branch>` が `difit <base-branch>` を実行するため、ワーキングディレクトリの diff ではなくベースブランチの最新コミット diff が表示され、かつ `--merge-base` 不在によりコメント注入が選択キー不一致で失敗する。前セッションの localStorage 残骸が新しいコメントを遮蔽する問題も併発。

## 決定

`mt difit start` の引数変換ロジックを修正し、`difit --clean --merge-base . <base-branch>` を実行する。difit の公式 CLI オプションのみを使用し、内部 API は使用しない。`--merge-base` によりサーバーとクライアントの選択キーが一致し、`commentImports` が正しく配信される。`--clean` により前セッションの localStorage 残骸がクリアされる。

## 代替案

- `/api/comment-imports` を複数選択キーに POST: difit の内部 API を叩くため脆弱。バージョンアップで壊れるリスク
- tado ワークフロー側で `mt difit start . main --merge-base` を呼ぶ: 呼び出し側の負担が増え、`mt difit start` のセマンティクスが不明確なまま
- difit 本体に修正 PR: 影響範囲が大きく、difit の設計意図（localStorage 優先）を変える必要がある

## 結果・影響

`mt difit start` のセマンティクスが「ワーキングディレクトリ vs ベースブランチのレビューセッション開始」に明確化される。コメント表示問題が根本解決される。

## 再採用範囲（ADR-0026）

ADR-0026 により、引数変換（`--clean` / `--merge-base` 等の公式 CLI オプション）と `--merge-base` による起動時の選択一致は再採用された。ただし「内部 API は使用しない」は、コメント選択のピン留め（コメント I/O を `/api/comments-json` / `/api/comment-imports` の `base` / `target` / `baseMode` クエリで固定する）に限り見直された。起動後のリビジョン切替で別セッションを無音で読む経路を塞ぐためで、契約は E2E テストで固定する。詳細は ADR-0026「コメント選択のピン留め」を参照。
