## 目的

writer-reviewer サイクルの機械監査を実行し、問題があれば修正ループを回す。

## 完了条件

auditWriterReviewerCycle が pass（auditWriter + auditReviewer + no_unresolved_must_fix + research_needed_addressed）

## 方針

### 監査の実行と完了判定

#### 1. 機械監査の実行

機械監査を実行する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/audit.ts cycle --cycle writer-reviewer --db-path <RESEARCH_DB> --report-path <SESSION>/report.md
```

#### 2. pass 時の完了

監査が pass なら完了

### findings の集約と再委譲

#### 3. review_findings の集約

監査が fail/error の場合、review_findings を集約する:
   - `db.ts snapshot --cycle writer-reviewer` で全 findings を取得
   - `must_fix` / `research_needed` / `suggestions` に分類
   - 重複や類似の指摘を統合

#### 4. must_fix への対応

`must_fix` がある場合:
   - 集約した must_fix を 1 つのプロンプトにまとめ、Writer に再委譲
   - `suggestions` のうち重要と判断したものも含める
   - Writer は `db.ts snapshot --cycle writer-reviewer` を再取得して report.md を更新
   - 修正後、全観点を再レビューする
   - 最大 3 回まで再委譲。3 回を超えたら人間に判断を仰ぐ

#### 5. research_needed への対応

`research_needed` がある場合:
   - `target_question_id` ごとにグルーピング
   - 問いごとに Researcher SubAgent を起動（`round_number` をインクリメント）
   - 追加調査後、全観点を再レビューする
   - 最大 3 回まで追加調査。3 回を超えたら人間に判断を仰ぐ

### 記録と再監査

#### 6. 改善ループの記録

改善ループの結果は `iterations` テーブルに記録する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts iteration save --db-path <RESEARCH_DB> --data '{"loop_number": 1, "iteration_type": "writer_fix", "summary": "..."}'
```

#### 7. サイクル監査の再実行

修正ループ後、再度サイクル監査を実行する

## 出力

監査結果。未解決があれば `iterations` テーブルに記録した改善ループの結果。

## 注意事項

- must_fix が残っているのに次のフェーズに進まない
- Writer → Reviewer ループは 1 回の report.md 更新あたり最大 3 回まで

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
report.md: <SESSION>/report.md
