# SubAgent 実行プロトコル（mt-deep-research）

`Subagent` ツールで mt-deep-research の SubAgent 作業を委譲するためのプロトコル。
オーケストレーターは本プロトコルに従い、フェーズごとに適切な SubAgent type を選び、入力、出力要件、統合方法を明示する。
各 SubAgent の Who 定義は `_cursor_user/agents/mt-deep-research-*.md` を Source of Truth とする。

## 基本原則

1. 親エージェント（オーケストレーター）はワークフロー全体、ユーザー対話、Human Gate、成果物集約を担当する。
2. SubAgent は割り当てられた計画作成、情報収集、レポート作成、レビューだけを担当する。
3. レビューは `readonly: true` を指定する。
4. 計画作成、情報収集、レポート作成は `readonly: false` を指定する。
5. SubAgent へ渡す prompt には、担当範囲、入力ファイル、出力ファイル、禁止事項を明示する。
6. SubAgent の結果は親エージェントが確認し、次のフェーズへ繋げる。

## 役割対応表

| 役割 | SubAgent type | readonly | Who 定義 |
| ---- | ---- | ---- | ---- |
| Planner | `mt-deep-research-planner` | false | `_cursor_user/agents/mt-deep-research-planner.md` |
| Researcher | `mt-deep-research-researcher` | false | `_cursor_user/agents/mt-deep-research-researcher.md` |
| Writer | `mt-deep-research-writer` | false | `_cursor_user/agents/mt-deep-research-writer.md` |
| Reviewer | `mt-deep-research-reviewer` | true | `_cursor_user/agents/mt-deep-research-reviewer.md` |

## ファイル命名規則

調査テーマごとに `tmp/research/yyyymmdd-[topic]/` ディレクトリを作成し、以下のファイルを管理する。

| ファイル | 作成者 | 用途 |
| ---- | ---- | ---- |
| `plan.md` | Planner | 研究計画書 |
| `evidence-{N}.md` | Researcher | 各調査ラウンドのエビデンス |
| `report.md` | Writer | 最終レポート |
| `review-{N}.md` | Reviewer | 各レビューの結果 |

## prompt 構築

SubAgent への prompt は以下の構造を基本にする。

```markdown
## 目的

{この委譲で達成すること}

## 担当範囲

{SubAgent が判断・作業してよい範囲}

## 入力

- {関連ファイルパス}
- {親エージェントが取得した調査結果やユーザーからの追加指示}

## 出力

{作成または更新するファイルパスとその形式}

## 禁止事項

- 担当範囲外の判断を確定しない
- Human Gate を代行しない
- UCR が必要な場合は `[UCR]` プレフィックスで報告する
```

## オーケストレーターのワークフロー

1. **前提チェック**（オーケストレーター）
   - SearXNG、`jq`、`pandoc` の可用性を確認する
2. **初期ヒアリング**（オーケストレーター）
   - 背景・目的・前提知識・制約・スコープをユーザーから引き出す
3. **ディレクトリ作成**（オーケストレーター）
   - `tmp/research/yyyymmdd-[topic]/` を作成する
4. **計画立案**（Planner）
   - 軽い事前調査を経て `plan.md` を作成する
   - オーケストレーターはユーザーに提示し、承認を得る
   - 承認されなければ Planner に改訂を依頼（最大 3 回）
5. **調査**（Researcher）
   - `plan.md` に基づき自律的に調査し、`evidence-{N}.md` を作成する
   - 最大 5 ループまで
6. **レポート作成**（Writer）
   - `plan.md` と `evidence-*.md` をもとに `report.md` を作成・更新する
7. **レビュー**（Reviewer）
   - `report.md` をレビューし、`review-{N}.md` を作成する
   - `must_fix` / `research_needed` / `suggestions` を出力する
8. **改善ループ**
   - `must_fix` がある場合は Writer に修正を依頼
   - `research_needed` がある場合は Researcher に追加調査を依頼
   - 1 回のレポート更新あたり最大 3 回まで繰り返す
   - それを超える場合はユーザーに判断を仰ぐ
9. **チェックポイント**（オーケストレーター）
   - 内部ループが収束したら、ユーザーに簡潔なサマリーを提示し、方向性を確認する
10. **最終レポートの確定**（Writer）
    - すべての主要な問いに回答できたら `report.md` を最終更新する

## 修正ループ

`must_fix` や `research_needed` に基づき、対象 SubAgent に再委譲する。

1. 親エージェントが該当する指摘を集約する
2. 対象成果物、該当指摘、修正方針、維持すべき制約を prompt に含める
3. 同じ SubAgent type に修正を依頼する
4. 修正後、Reviewer に再レビューを依頼する

## エラーハンドリング

1. SubAgent の出力が空、形式不備、担当範囲逸脱の場合、親エージェントが 1 回だけ修正依頼を行う。
2. 同じ問題が続く場合は、失敗した役割、入力、期待出力、観測した問題をユーザーに報告して判断を仰ぐ。
3. UCR とレビュー指摘が同時に発生した場合は、UCR 処理を先に行う。
