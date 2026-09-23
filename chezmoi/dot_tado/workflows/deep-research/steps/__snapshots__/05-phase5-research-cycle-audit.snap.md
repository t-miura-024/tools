## 目的

research サイクル全体の機械監査を実行し、問題があれば Auditor に意味整合性評価を依頼する。

## 完了条件

auditResearchCycle が pass

## 方針

### 手順

1. 機械監査を実行する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/audit.ts cycle --cycle research --db-path <RESEARCH_DB>
```

2. 監査が pass なら完了
3. 監査が fail/error の場合:
   - `mt-deep-research-auditor` SubAgent を呼び出して意味的整合性を評価
   - Auditor には `db.ts snapshot --cycle research` の出力を渡す
   - 監査結果は workflow engine の step_attempts に自動保存される
   - 必要に応じて Researcher に追加調査を依頼

### 監査コマンド

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/audit.ts cycle --cycle research --db-path <RESEARCH_DB>
```

## 出力

research サイクル監査の結果。fail/error 時は Auditor の評価と追加調査の依頼。

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
