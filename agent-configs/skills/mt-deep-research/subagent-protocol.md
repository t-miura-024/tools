# SubAgent 実行プロトコル（mt-deep-research）

`Subagent` ツールで mt-deep-research の SubAgent 作業を委譲するためのプロトコル。
オーケストレーターは本プロトコルに従い、フェーズごとに適切な SubAgent type を選び、入力、出力要件、監査タイミング、統合方法を明示する。
各 SubAgent の責務スコープは `agent-configs/agents/mt-deep-research-*.md` を Source of Truth とする。

## 基本原則

1. **親エージェント（オーケストレーター）はワークフロー全体、ユーザー対話、Human Gate、監査、成果物集約を担当する。**
2. SubAgent は割り当てられた計画作成、情報収集、レポート作成、レビュー、総合監査だけを担当する。
3. レビューと総合監査は `readonly: true` を指定する。
4. 計画作成、情報収集、レポート作成は `readonly: false` を指定する。
5. SubAgent へ渡す prompt には、担当範囲、入力 JSON、期待する出力、禁止事項を明示する。
6. SubAgent の結果は親エージェントが `db.ts` 経由で SQLite に永続化する。
7. **Researcher は問いごと、Reviewer は観点ごとに並列で起動する。**
8. 並列 SubAgent の結果は、親エージェントが集約・統合して次のフェーズに進む。
9. **書き込みは常にオーケストレーターが行う**。SubAgent はファイルを直接編集しない（`db.ts` 経由でも、最終的なファイル I/O は親が行う）。

## 役割対応表

| 役割 | SubAgent type | readonly | 書き込み経路 |
| --- | --- | --- | --- |
| Planner | `mt-deep-research-planner` | false | `db.ts question create` + `plan.md` 作成 |
| Researcher | `mt-deep-research-researcher` | false | `db.ts evidence save` |
| Writer | `mt-deep-research-writer` | false | `report.md` 作成・更新 |
| Reviewer | `mt-deep-research-reviewer` | true | `db.ts review save` |
| Auditor | `mt-deep-research-auditor` | true | JSON 返却のみ（orchestrator が `db.ts audit save` で永続化） |

## DB と成果物

### 中間生成物（SQLite に閉じる）

`tmp/research/yyyymmdd-[topic]/research.db` に保存する。人間に見せない。

| テーブル | 作成者 | 用途 |
| --- | --- | --- |
| `questions` | Planner | 主要な問い |
| `evidence_rounds` | Researcher | 各問いの調査ラウンド |
| `sources` | Researcher | 情報源 |
| `facts` | Researcher | 抽出事実 |
| `off_topic_questions` | Researcher | 目的外問い |
| `reviews` | Reviewer | 観点別レビュー |
| `review_findings` | Reviewer | must_fix / research_needed / suggestions |
| `audits` | orchestrator | 監査結果 |
| `audit_checks` | orchestrator | 個別監査チェック |
| `iterations` | orchestrator | 改善ループ履歴 |
| `execution_logs` | orchestrator | スクリプト実行ログ |

### 人間に見せる成果物

| ファイル | 作成者 | 用途 |
| --- | --- | --- |
| `plan.md` | Planner | 研究計画書（mermaid 必須） |
| `report.md` | Writer | 最終レポート（mermaid 必須） |

## prompt 構築

SubAgent への prompt は以下の構造を基本にする。

```markdown
## 目的

{この委譲で達成すること}

## 担当範囲

{SubAgent が判断・作業してよい範囲。担当観点や問いを明示する。}

## 入力（DB スナップショット）

\`\`\`bash
bun run scripts/db.ts snapshot --cycle <research|writer-reviewer> \\
  --db-path tmp/research/yyyymmdd-[topic]/research.db \\
  [--report-path tmp/research/yyyymmdd-[topic]/report.md]
\`\`\`

\`\`\`json
{db.ts snapshot の出力 JSON}
\`\`\`

## 出力

{db.ts <subcommand> で書き出す JSON 形式。例:}

\`\`\`bash
bun run scripts/db.ts <subcommand> save \\
  --db-path tmp/research/yyyymmdd-[topic]/research.db \\
  --data '{ ... }'
\`\`\`

## 禁止事項

- 担当範囲外の判断を確定しない
- Human Gate を代行しない
- ファイルを直接編集しない（必ず `db.ts` 経由）
- UCR が必要な場合は `[UCR]` プレフィックスで報告する
```

### Researcher への prompt 追加項目

- 担当する `question_id` と、その問いの `content`
- `round_number`（追加ラウンドの場合はインクリメント済み）
- 同じ (question_id, round_number) で 2 回保存すると**上書き**される点
- 他の問いの調査結果を参照しない（必要に応じてオーケストレーターが統合する）

### Reviewer への prompt 追加項目

- 担当するレビュー観点（識別子と説明）
- 直近の `report.md` 全文はスナップショットに含まれている
- 担当観点以外の指摘は行わない
- `must_fix` / `research_needed` / `suggestions` の各カテゴリで出力する
- `research_needed` には `target_question_id` を必ず付ける

### Auditor への prompt 追加項目

- 監査対象サイクル（`research` / `writer-reviewer`）
- 入力は `db.ts snapshot` の出力 JSON
- 出力は **JSON 1 個だけ**（Markdown フェンスで囲むのは可）
- ファイルを書かない、DB を編集しない

## オーケストレーターのワークフロー

```
Phase 0: 前提チェック
  ├─ SearXNG, jq, pandoc, bun の確認
  └─ scripts/node_modules が無ければ `cd scripts && bun install`

Phase 1: 事前ヒアリング（orchestrator）
  └─ 背景・目的・前提知識を引き出す（制約・スコープは Planner 任せ）

Phase 2: ディレクトリ + DB 初期化（orchestrator）
  └─ `db.ts init --db-path tmp/research/.../research.db`

Phase 3: Planner
  ├─ 軽い事前調査 → questions テーブル登録 + plan.md 作成
  ├─ lint: `lint.ts --file plan.md`
  ├─ audit: `audit.ts phase --phase planner`
  ├─ NG なら Planner へフィードバック（最大 3 回）
  └─ ユーザー承認後に `db.ts question update --status approved`

Phase 4: Researcher（並列、最大 5 同時）
  ├─ 各 Researcher に `question_id` を割り当て
  ├─ `db.ts evidence save` で一括保存
  ├─ audit: `audit.ts phase --phase researcher --question-id N`
  └─ NG なら Researcher へフィードバック（最大 3 回）

Phase 5: research サイクル監査
  ├─ `audit.ts cycle --cycle research`
  └─ NG の場合、Auditor を呼び出して意味監査 → `db.ts audit save`

Phase 6: チェックポイント
  └─ off_topic_questions をユーザーに確認 → `decision` を更新

Phase 7: Writer
  ├─ `db.ts snapshot --cycle writer-reviewer` を渡す
  ├─ report.md を作成・更新
  ├─ lint: `lint.ts --file report.md`
  └─ audit: `audit.ts phase --phase writer`

Phase 8: Reviewer（並列、5 観点）
  ├─ 各 Reviewer に観点（coverage/sources/accuracy/structure/citations）を割り当て
  ├─ `db.ts review save` で JSON 保存
  └─ audit: `audit.ts phase --phase reviewer`

Phase 9: writer-reviewer サイクル監査 + 改善ループ
  ├─ `audit.ts cycle --cycle writer-reviewer`
  ├─ must_fix あり → Writer に再委譲（最大 3 回）
  ├─ research_needed あり → Researcher に追加ラウンド（最大 3 回）
  └─ イテレーションを `iterations` テーブルに記録

Phase 10: 最終レポート確定
  ├─ `report.md` を最終更新
  └─ lint + サイクル監査を再実行

Phase 11: 完了報告
  └─ 簡潔なメッセージ + ファイルパスのみ
```

## 並列起動の詳細

### Researcher の並列起動

- 承認された問いの `question_id` ごとに `mt-deep-research-researcher` を起動する
- 各 SubAgent には `question_id` と `db.ts snapshot --cycle research` の出力を渡す
- すべての Researcher の完了を待ってから Phase 5 に進む
- 同時起動数は最大 5 つ。問いが 5 つを超える場合はバッチ化する

### Reviewer の並列起動

- 5 つの観点（`coverage` / `sources` / `accuracy` / `structure` / `citations`）ごとに `mt-deep-research-reviewer` を起動する
- 各 SubAgent には観点識別子と `db.ts snapshot --cycle writer-reviewer` の出力を渡す
- すべての Reviewer の完了を待ってからオーケストレーターが `db.ts snapshot` で集約する
- 同時起動数は最大 5 つ（通常は 5 つ同時に起動する）

## 監査タイミング

| タイミング | 監査コマンド | 失敗時の対応 |
| --- | --- | --- |
| plan.md 作成後 | `lint.ts --file plan.md` + `audit.ts phase --phase planner` | Planner フィードバック（最大 3 回） |
| 各 Researcher 完了後 | `audit.ts phase --phase researcher --question-id N` | Researcher フィードバック（最大 3 回） |
| 全 Researcher 完了後 | `audit.ts cycle --cycle research` | 必要に応じて Auditor 呼び出し |
| report.md 作成後 | `lint.ts --file report.md` + `audit.ts phase --phase writer` | Writer フィードバック（最大 3 回） |
| 全 Reviewer 完了後 | `audit.ts phase --phase reviewer` | Reviewer フィードバック（最大 3 回） |
| Writer → Reviewer 完了後 | `audit.ts cycle --cycle writer-reviewer` | 改善ループへ |
| 最終確定時 | `lint.ts --file report.md` + `audit.ts cycle --cycle writer-reviewer` | エスカレーション |

### 人間エスカレーション

1 フェーズ・サイクルあたり自動リトライは最大 3 回まで。3 回を超えて NG が残る場合は、`iterations` テーブルに記録した上で人間に判断を仰ぐ。提示する選択肢の例:

- 範囲を狭めて再試行する
- 現状で確定する
- 調査を中断する

## 指摘の集約（Reviewer → Writer / Researcher）

オーケストレーターはすべての観点の `review_findings` を `db.ts snapshot --cycle writer-reviewer` で取得し、指摘を種別ごとに集約する。

```sql
-- reviews と review_findings を snapshot 経由で取得
-- category でグループ化し、target_question_id で research_needed を束ねる
```

集約の手順:

1. `review_findings` を `category` で分類する（`must_fix` / `research_needed` / `suggestions`）
2. 重複や類似の指摘を統合する
3. `must_fix` は Writer への 1 つのプロンプトにまとめる
4. `research_needed` は `target_question_id` ごとにグルーピングし、問いごとに Researcher 1 つに渡す
5. `suggestions` は Writer へのプロンプトに含めるかをオーケストレーターが判断する

## 修正ループ

### Writer への修正依頼

- 集約した `must_fix` を 1 つの prompt として Writer に渡す
- `suggestions` のうち、オーケストレーターが重要と判断したものも含める
- Writer は `db.ts snapshot --cycle writer-reviewer` を再取得して `report.md` を更新する
- 修正後、すべての観点を再レビューする

### Researcher への追加調査依頼

- 集約した `research_needed` を `target_question_id` ごとにグルーピングする
- 問いごとに 1 つの Researcher SubAgent を起動し、その問いに関するすべての追加調査項目を渡す
- `round_number` を 1 増やして `evidence save` を実行する
- 追加調査後、すべての観点を再レビューする
- 開始時に `iterations` テーブルに `iteration_type: 'researcher_revisit'` を記録する

## エラーハンドリング

1. SubAgent の出力が空、形式不備、担当範囲逸脱の場合、親エージェントが 1 回だけ修正依頼を行う。
2. 並列 SubAgent のうち一部が失敗した場合、成功した結果は保持し、失敗した SubAgent のみを再委譲する。
3. 監査 NG が 3 回連続で解消されない場合は、`iterations` テーブルに `iteration_type: 'audit_retry'` を記録し、人間エスカレーションする。
4. UCR とレビュー指摘が同時に発生した場合は、UCR 処理を先に行う。
5. `lint.ts` で prettier / markdownlint / mermaid 構文エラーが出た場合、まず `lint.ts` を再実行して自動整形で解決するかを確認する。自動整形で解決しない場合は、Writer または Planner に明示的な修正を依頼する。
