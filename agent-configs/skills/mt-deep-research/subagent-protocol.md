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
7. **Researcher は主要な問いごとに、Reviewer はレビュー観点ごとに並列で起動する**。
8. 並列 SubAgent の結果は、親エージェントが集約・統合して次のフェーズに進む。

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
| `evidence-q{N}.md` | Researcher | 主要な問い `N` に対するエビデンス |
| `evidence-q{N}-{M}.md` | Researcher | 主要な問い `N` の追加調査ラウンド `M` のエビデンス |
| `report.md` | Writer | 最終レポート |
| `review-{aspect}.md` | Reviewer | 観点 `aspect` のレビュー結果 |
| `review-{aspect}-{M}.md` | Reviewer | 観点 `aspect` の改善ループ `M` のレビュー結果 |

レビュー観点の識別子:

| 観点 | 識別子 |
| ---- | ---- |
| 主要な問いへの回答度 | `coverage` |
| 情報源の網羅性と信頼性 | `sources` |
| 事実の正確性と誇張の有無 | `accuracy` |
| 論理構成と読みやすさ | `structure` |
| 引用形式の正確さ | `citations` |

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

### Researcher への prompt 追加項目

並列化された Researcher には、以下を明示する。

- 担当する主要な問いの番号と内容
- 出力ファイル名（例: `evidence-q2.md`）
- 追加調査ラウンドの場合、前回のエビデンスファイルパス（例: `evidence-q2.md`）と新しい出力ファイル名（例: `evidence-q2-2.md`）
- 他の問いの調査結果を参照しない（必要に応じてオーケストレーターが統合する）

### Reviewer への prompt 追加項目

並列化された Reviewer には、以下を明示する。

- 担当するレビュー観点（識別子と説明）
- 出力ファイル名（例: `review-accuracy.md`）
- 再レビューの場合、前回のレビュー結果ファイルパス（例: `review-accuracy.md`）と新しい出力ファイル名（例: `review-accuracy-2.md`）
- 担当観点以外の指摘は行わない
- `must_fix` / `research_needed` / `suggestions` の各カテゴリで出力する

## オーケストレーターのワークフロー

1. **前提チェック**（オーケストレーター）
   - SearXNG、`jq`、`pandoc` の可用性を確認する
2. **初期ヒアリング**（オーケストレーター）
   - 背景・目的・前提知識をユーザーから引き出す
   - 制約・スコープのヒアリングは行わない
3. **ディレクトリ作成**（オーケストレーター）
   - `tmp/research/yyyymmdd-[topic]/` を作成する
4. **計画立案**（Planner）
   - 軽い事前調査を経て `plan.md` を作成する
   - 主要な問い（3〜7 個を目安、最大 5 個まで推奨）を提案する
   - 制約・スコープを提案する
   - オーケストレーターはユーザーに要約を提示し、承認を得る
   - 承認されなければ Planner に改訂を依頼（最大 3 回）
5. **調査**（Researcher、並列）
   - `plan.md` に基づき、主要な問いごとに Researcher SubAgent を並列起動する
   - 同時起動数の上限は 5 つ。超える場合はバッチ化する
   - 各 Researcher は担当する問いについて自律的に調査し、`evidence-q{N}.md` を作成する
   - 最大 3 ループまで
6. **レポート作成**（Writer）
   - `plan.md` と `evidence-*.md` をもとに `report.md` を作成・更新する
7. **レビュー**（Reviewer、並列）
   - `report.md` をレビューするため、5 つの観点ごとに Reviewer SubAgent を並列起動する
   - 各 Reviewer は担当観点からレビューし、`review-{aspect}.md` を作成する
   - `must_fix` / `research_needed` / `suggestions` を出力する
8. **改善ループ**
   - オーケストレーターはすべての `review-{aspect}*.md` を読み込み、指摘を種別ごとに集約する
   - `must_fix` がある場合は、集約した指摘を 1 つの prompt として Writer に修正を依頼
   - `research_needed` がある場合は、問いごとに指摘をまとめ、対応する Researcher に追加調査を依頼
   - 1 回の `report.md` 更新あたり最大 3 回まで繰り返す
   - それを超える場合はユーザーに判断を仰ぐ
9. **チェックポイント**（オーケストレーター）
   - 内部ループが収束したら、ユーザーに簡潔なサマリーを提示し、方向性を確認する
10. **最終レポートの確定**（Writer）
    - すべての主要な問いに回答できたら `report.md` を最終更新する

## 並列起動の詳細

### Researcher の並列起動

- 主要な問いの数だけ `mt-deep-research-researcher` を起動する
- 各 SubAgent には、担当する問いの番号・内容・出力ファイルパスを明示する
- すべての Researcher の完了を待ってから Writer に委譲する
- 同時起動数は最大 5 つまで。問いが 5 つを超える場合は、5 つずつバッチ化して起動する

### Reviewer の並列起動

- 5 つの観点ごとに `mt-deep-research-reviewer` を起動する
- 各 SubAgent には、担当する観点の識別子・説明・出力ファイルパスを明示する
- すべての Reviewer の完了を待ってから、オーケストレーターが指摘を集約する
- 同時起動数は最大 5 つまで（通常は 5 つ同時に起動する）

## 指摘の集約

オーケストレーターは並列で出力された複数のレビューファイルから指摘を集約し、次の SubAgent への委譲材料を作成する。

集約の手順:

1. すべての `review-{aspect}*.md` を読み込む
2. `must_fix`、`research_needed`、`suggestions` をカテゴリごとに分類する
3. 重複や類似の指摘を統合する
4. 優先順位を付ける
5. 以下の形式で 1 つの集約 prompt を作成する

```markdown
## 修正依頼

### must_fix

- [指摘の内容と対象箇所]
- ...

### research_needed

#### 問い N

- [追加調査が必要な内容]
- ...

#### 問い M

- [追加調査が必要な内容]
- ...

### suggestions

- [改善案]
- ...

## 維持すべき制約

- [レポート構成、引用形式などの制約]
```

## 修正ループ

### Writer への修正依頼

- 集約した `must_fix` を 1 つの prompt として Writer に渡す
- `suggestions` のうち、オーケストレーターが重要と判断したものも含める
- 修正後、すべての観点を再レビューする

### Researcher への追加調査依頼

- 集約した `research_needed` を問いごとにグルーピングする
- 問いごとに 1 つの Researcher SubAgent を起動し、その問いに関するすべての追加調査項目を渡す
- 出力ファイル名は `evidence-q{N}-{M}.md`（`M` は追加調査ラウンド番号）とする
- 追加調査後、すべての観点を再レビューする

## エラーハンドリング

1. SubAgent の出力が空、形式不備、担当範囲逸脱の場合、親エージェントが 1 回だけ修正依頼を行う。
2. 並列 SubAgent のうち一部が失敗した場合、成功した結果は保持し、失敗した SubAgent のみを再委譲する。
3. 同じ問題が続く場合は、失敗した役割、入力、期待出力、観測した問題をユーザーに報告して判断を仰ぐ。
4. UCR とレビュー指摘が同時に発生した場合は、UCR 処理を先に行う。
