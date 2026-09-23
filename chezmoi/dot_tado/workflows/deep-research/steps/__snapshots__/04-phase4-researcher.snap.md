## 目的

承認されたすべての問いについて、Researcher SubAgent を並列起動し、調査を実行する。

## 完了条件

auditResearcher が pass（evidence_rounds_exist / sources_present）

## 方針

### 事前準備

plan.md で承認された問い（draft 状態）を approved に更新する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts question list --db-path <RESEARCH_DB>
# 表示された draft の問いをすべて approved に更新
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts question update --id <ID> --status approved --db-path <RESEARCH_DB>
```

### 手順

1. research.db から approved 状態の questions を取得する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts question list --status approved --db-path <RESEARCH_DB>
```

2. 各 question_id に対して `mt-deep-research-researcher` SubAgent を並列起動する（最大 5 同時）
   - 各 SubAgent には question_id、round_number、`db.ts snapshot --cycle research` の出力を渡す
   - 期待する成果物: evidence_rounds / sources / facts / off_topic_questions の一括保存
   - 保存は SubAgent が `db.ts evidence save --data '...'` で行う
   - 各 Researcher のループは最大 5 ラウンド
   - 担当する question_id 以外の調査結果を参照しない

3. 各 Researcher 完了後、機械監査を実行する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/audit.ts phase --phase researcher --db-path <RESEARCH_DB> --question-id <ID>
```

4. 監査 NG の場合は該当 Researcher にフィードバック（最大 3 回まで再委譲）
5. 3 回を超えても NG の場合は人間に「範囲を狭める」「このまま進める」「中断する」を提示

## 出力

外部通信（外部 URL 取得・SearXNG クエリ）の前に、送信先・データ・目的を宣言する（Researcher SubAgent にも遵守させる）

## 注意事項

- 全問いの調査が完了する前に次のフェーズに進まない
- SubAgent に他の問いの調査結果を混入させない

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
未反映の差し戻し（枯渇時・plan-approval-exhausted.json の永続化。なければなし）: - (なし。枯渇なし)
