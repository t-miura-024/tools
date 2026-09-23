## 目的

off_topic_questions をユーザーに提示し、追加調査するか判断を仰ぐ。

## 完了条件

auditResearchCycle が pass（off_topic_resolved）

## 方針

### 手順

1. off_topic_questions を取得する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts snapshot --cycle research --db-path <RESEARCH_DB>
```

2. スナップショットの `off_topic_questions` を確認する
3. 各 off_topic_question の内容をユーザーに提示し、追加調査するか確認する
4. ユーザーの判断に基づいて `decision` を更新する:
   - `include`: 追加調査に含める → Researcher で追加調査
   - `exclude`: 対象外とする

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts evidence save --db-path <RESEARCH_DB> --data '{"question_id": <ID>, "round_number": <N>, "off_topic_questions": [{"content": "...", "decision": "include"}]}'
```

5. ユーザーが `include` を選択した off_topic_question があれば、Researcher に追加調査を依頼する

## 出力

off_topic_questions へのユーザー判断（include/exclude）の反映。

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
