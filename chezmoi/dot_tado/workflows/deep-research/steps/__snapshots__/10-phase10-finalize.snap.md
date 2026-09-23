## 目的

report.md を最終更新し、lint を実行してレポートを確定する。

## 完了条件

auditWriterReviewerCycle が pass かつ lint が pass かつ report に禁止コンテンツ（次のアクション/未解決の問い/中間まとめ/SearXNG 信頼性）がないこと

## 方針

### 手順

1. `lint.ts` で report.md をフォーマット・lint する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/lint.ts --file <SESSION>/report.md
```

2. 最終サイクル監査を実行する

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/deep-research/scripts/audit.ts cycle --cycle writer-reviewer --db-path <RESEARCH_DB> --report-path <SESSION>/report.md
```

3. lint エラーがある場合は Writer に明示的な修正を依頼（最大 3 回）
4. レポートに未解決の問い・次のアクション・中間まとめ・SearXNG 信頼性注意書きが含まれていないか確認
5. report.md 全文はセッションに出さない

## 出力

lint 済みの確定版 report.md。

## インプット

セッションディレクトリ: <SESSION>
research.db: <RESEARCH_DB>
report.md: <SESSION>/report.md
