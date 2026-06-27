# SubAgent 実行プロトコル

`Subagent` ツールで SDD SubAgent の作業を委譲するためのプロトコル。
オーケストレーターは本プロトコルに従い、フェーズごとに適切な SubAgent type を選び、入力、出力要件、統合方法を明示する。
各 SubAgent の Who 定義は `_cursor_user/agents/mt-sdd-*.md` を Source of Truth とする。

## 基本原則

1. 親エージェントはワークフロー全体、ユーザー対話、Human Gate、UCR 承認、成果物集約を担当する。
2. SubAgent は割り当てられた分析、作成、レビュー、実装、検証だけを担当する。
3. レビュー、監査、検証など読み取り専用で足りる委譲は `readonly: true` を基本にする。
4. 仕様書作成、実装計画作成、実装など成果物作成やファイル編集が必要な委譲は `readonly` を付けない。
5. SubAgent へ渡す prompt には、担当範囲、入力ファイル、出力形式、禁止事項を明示する。
6. SubAgent の結果は親エージェントが確認し、テンプレートに従って `tmp/mt-sdd/` 配下の成果物へ集約する。

## 役割対応表

| 役割 | SubAgent type | readonly | Who 定義 |
| ---- | ---- | ---- | ---- |
| Codebase Explorer | `explore` | true | 環境提供の `explore` |
| External Source Fetcher | 親エージェントが MCP 優先で取得 | - | - |
| Spec Writer | `mt-sdd-spec-writer` | false | `_cursor_user/agents/mt-sdd-spec-writer.md` |
| Completeness Reviewer | `mt-sdd-completeness-reviewer` | true | `_cursor_user/agents/mt-sdd-completeness-reviewer.md` |
| Feasibility Reviewer | `mt-sdd-feasibility-reviewer` | true | `_cursor_user/agents/mt-sdd-feasibility-reviewer.md` |
| Consistency Reviewer | `mt-sdd-consistency-reviewer` | true | `_cursor_user/agents/mt-sdd-consistency-reviewer.md` |
| Risk Reviewer | `mt-sdd-risk-reviewer` | true | `_cursor_user/agents/mt-sdd-risk-reviewer.md` |
| Implementation Planner | `mt-sdd-implementation-planner` | false | `_cursor_user/agents/mt-sdd-implementation-planner.md` |
| Spec Alignment Reviewer | `mt-sdd-spec-alignment-reviewer` | true | `_cursor_user/agents/mt-sdd-spec-alignment-reviewer.md` |
| Architecture Reviewer | `mt-sdd-architecture-reviewer` | true | `_cursor_user/agents/mt-sdd-architecture-reviewer.md` |
| Task Structure Reviewer | `mt-sdd-task-structure-reviewer` | true | `_cursor_user/agents/mt-sdd-task-structure-reviewer.md` |
| Risk/Impact Reviewer | `mt-sdd-risk-impact-reviewer` | true | `_cursor_user/agents/mt-sdd-risk-impact-reviewer.md` |
| Implementer | `mt-sdd-implementer` | false | `_cursor_user/agents/mt-sdd-implementer.md` |
| Code Reviewer | `mt-sdd-code-reviewer` | true | `_cursor_user/agents/mt-sdd-code-reviewer.md` |
| Validator | `mt-sdd-validator` | true | `_cursor_user/agents/mt-sdd-validator.md` |
| Process Auditor | `mt-sdd-process-auditor` | true | `_cursor_user/agents/mt-sdd-process-auditor.md` |

## prompt 構築

SubAgent の prompt は以下の構造を基本にする。

```markdown
## 目的

{この委譲で達成すること}

## 担当範囲

{SubAgent が判断・作業してよい範囲}

## 入力

- {関連ファイルパス}
- {親エージェントが取得した調査結果や差分}
- {必要なテンプレート・レビュー基準}

## 出力要件

{親エージェントが集約しやすい形式}

## 禁止事項

- 担当範囲外の判断を確定しない
- Human Gate を代行しない
- UCR が必要な場合は `[UCR]` プレフィックスで報告する
```

## 入力の渡し方

| 入力の種類 | 渡し方 |
| ---- | ---- |
| 成果物ファイル（`spec.md` など） | ファイルパスを prompt に明記し、SubAgent に Read させる |
| テンプレート・レビュー基準 | ファイルパスを明記する。必要に応じて親エージェントが要点を埋め込む |
| git diff | 親エージェントが事前取得し、prompt に埋め込む |
| 外部ソース | 親エージェントが MCP 優先で取得し、構造化結果を prompt に渡す |

## 並列実行

4 観点レビュアーは、同一メッセージで複数の `Subagent` tool call を発行して並列実行する。

1. 観点ごとに `Subagent` tool call を用意する
2. すべて `readonly: true` を指定する
3. 各 SubAgent の出力を親エージェントが受け取る
4. 親エージェントがレビュー結果をテンプレートへ集約する

## 修正ループ

Critical 指摘がある場合は、対象成果物を作成した SubAgent type に再委譲する。

1. 親エージェントが Critical 指摘を集約する
2. 対象成果物、該当指摘、修正方針、維持すべき制約を prompt に含める
3. 同じ SubAgent type に修正を依頼する
4. 修正後、対象レビューを再実行する

`Subagent` の `resume` は、同一 SubAgent の継続文脈が実際に必要な場合だけ使う。
通常は成果物ファイルと指摘内容を明示して再委譲し、永続的なセッション ID ファイルは作らない。

## エラーハンドリング

1. SubAgent の出力が空、形式不備、担当範囲逸脱の場合、親エージェントが 1 回だけ修正依頼を行う。
2. 同じ問題が続く場合は、失敗した役割、入力、期待出力、観測した問題をユーザーに報告して判断を仰ぐ。
3. UCR と Critical 指摘が同時に発生した場合は、UCR 処理を先に行う。
