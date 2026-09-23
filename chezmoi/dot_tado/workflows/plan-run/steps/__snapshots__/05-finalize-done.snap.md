## 目的

計画 Issue を `done` に遷移し、完了処理を行う。

## 方針

### 1. Issue body の再読み込みと最終確認

Issue body を再読み込みし、完了条件がすべて満たされていることを最終確認する

### 2. done への遷移

`transition-plan.ts` を使って `in-progress` → `done` に遷移する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/shared/plan-transition-plan/main.ts <number> done
```

このコマンドは以下を自動実行する:
- GitHub Project の Status を `done` に更新
- Issue を close
- `## 🐢 履歴` へ遷移エントリを追記
- 親計画が存在する場合は自動的に親の状態集約を行う（出力の `parent:` 行を確認）

### 3. 完了報告

完了を報告する:
   - Issue の URL・番号
   - 完了した作業
   - 残っている未決事項（あれば）


## 出力

report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:
```json
{"key": "plan-number.txt", "path": "<SESSION>/plan-number.txt"}
```

## インプット

セッションディレクトリ: <SESSION>
