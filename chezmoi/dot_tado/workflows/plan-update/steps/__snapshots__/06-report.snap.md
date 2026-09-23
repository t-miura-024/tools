## 目的

更新内容をレポートにまとめ、Issueコメントとセッションディレクトリに残す。

## 手順

### 1. レポート生成

セッションディレクトリの `analysis.md`, `evidence.json`, `body-diff.md`, `issue-number.txt` をもとに、`report.md` を生成する。

レポートは以下の必須見出しを持つこと:
- `## 走査サマリ`
- `## 前提崩れ一覧`
- `## grill 決定ログ`
- `## 更新差分サマリ`
- `## 次アクション`

内容:
- 走査サマリ（対象ファイル数、関連Issue/PR、走査手法、evidence の query/tool/timestamp）
- 前提崩れ一覧（Blocker/Warning/Info、各項目の重要度と根拠リンク）
- grill決定ログ（主要な決定と理由、未決/保留があれば明記）
- 更新差分サマリ（body-diff.mdの要約、差分行数）
- 次アクション（残論点、後続タスク、plan-runで実行可能か）
- Issue URL・番号、対象repo、付与ラベル

### 2. 完了報告

以下を報告する:
- Issue URL・番号
- 対象repo
- 更新されたセクション
- 付与ラベル（plan:update）
- レポート保存先（セッションディレクトリ）
- 次のステップ（必要に応じて plan-run で実行）

## 成果物

report 時の `artifacts` に以下を含める:
```json
{"key": "report.md", "path": "<SESSION>/report.md"}
```

## セッション情報

- セッションディレクトリ: <SESSION>
