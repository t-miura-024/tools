## 目的

「accuracy」観点で report.md をレビューする。

## 完了条件

auditReviewer が pass（all_aspects_reviewed / all_reviews_have_findings）

## 方針

### 観点説明: accuracy

事実の正確性：evidence とレポートの記述が一致しているか

### 入力の取得

以下のスナップショットから report.md と research.db の内容を取得する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts snapshot --cycle writer-reviewer --db-path <RESEARCH_DB> --report-path <SESSION>/report.md
```

## 出力

`db.ts review save` で JSON を保存する。findings は以下のカテゴリで分類する:
- `must_fix`: 修正が必須の問題
- `research_needed`: 追加調査が必要な項目（`target_question_id` を必ず付与）
- `suggestions`: 任意の改善提案

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts review save --db-path <RESEARCH_DB> --data '{ ... }'
```

## 注意事項

- 担当観点以外の指摘を行わない
- ファイルを直接編集しない

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
report.md: <SESSION>/report.md
観点: accuracy
