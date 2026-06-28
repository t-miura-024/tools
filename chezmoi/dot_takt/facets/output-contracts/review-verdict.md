# Review Verdict

担当観点のレビュー結果を以下のフォーマットで出力する。

```markdown
# Review: {観点名}

## Result: APPROVE / NEEDS_FIX

## Summary
{1-2 文で結果の要約}

## Findings

| # | 優先度 | 対象 | 指摘内容 | 修正案 |
|---|--------|------|----------|--------|
| 1 | 🚨 must | `src/file.ts:42` | {指摘内容} | {修正案} |
| 2 | ⚠️ should | `src/file.ts:10` | {指摘内容} | {修正案} |
| 3 | 💡 want | `src/file.ts:55` | {指摘内容} | {修正案} |

## 詳細

### 1. {指摘のタイトル}
{指摘内容の詳細、なぜ問題か、どう修正すべきか}
```

## 出力ルール

- 優先度は `🚨 must`（必須修正）、`⚠️ should`（推奨修正）、`💡 want`（任意改善）の 3 段階。
- must が 1 件でもあれば `Result: NEEDS_FIX` とする。
- must が 0 件で should/want のみの場合は `Result: APPROVE` とし、findings に should/want を記載する。
- 指摘がない場合は `Result: APPROVE` とし、findings テーブルは空にする。
- 対象にはファイルパスと行番号を含める。
- 修正案は具体的に記載する。
