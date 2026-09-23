## 目的

収集された調査結果をもとに report.md を作成・更新する。

## 完了条件

auditWriter が pass（report_md_exists / report_md_required_sections / report_md_has_citations / report_md_has_mermaid）

## 方針

### 担当範囲

- report.md の作成・更新（`<REPO>/chezmoi/dot_tado/workflows/deep-research/templates/report.md` の構成に従う、mermaid 必須）
- 番号引用 `[N]` は sources.source_number と一致させる
- 情報源は `## 情報源の一覧` に含める

### 入力の取得

`db.ts snapshot --cycle writer-reviewer` の出力を使用する。

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/db.ts snapshot --cycle writer-reviewer --db-path <RESEARCH_DB> --report-path <SESSION>/report.md
```

## 出力

report.md を <SESSION>/report.md に書き出す。

## 注意事項

- ファイルを直接編集しない（report.md は書き込み可）
- 未解決の問い・次のアクション・中間まとめを含めない
- SearXNG 信頼性注意書きを含めない
- レポートの全文をセッションに出力しない（完了報告は簡潔に）

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
report.md 出力先: <SESSION>/report.md
report テンプレート: <REPO>/chezmoi/dot_tado/workflows/deep-research/templates/report.md
