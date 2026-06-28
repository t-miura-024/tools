# Execution Report

実行ステップの結果を以下のフォーマットで出力する。

```markdown
# Execution Report

## Status: COMPLETED / NEEDS_USER_ACTION / BLOCKED

## Summary
{1-3 文で実行内容の要約}

## Changes

| ファイル | 変更種別 | 内容 |
|----------|----------|------|
| `src/file.ts` | 編集 | {変更内容} |
| `src/new-file.ts` | 新規作成 | {作成内容} |

## Verification

{実行した検証コマンドと結果。検証コマンドを実行していない場合は「検証未実施」と記載。}

```
{コマンド出力または結果サマリ}
```

## User Action Required

{Status が NEEDS_USER_ACTION の場合のみ記載。ユーザーが手動で行う必要がある作業の目的、操作、完了報告方法を記載。Status が COMPLETED の場合はこのセクションを省略。}

## Next Steps

{次に進むべきアクション、または中断する場合はその理由。}
```

## 出力ルール

- Status は `COMPLETED`（AI が直接完結）、`NEEDS_USER_ACTION`（ガイドモード、ユーザー手動作業が必要）、`BLOCKED`（進行不可）のいずれか。
- ガイドモードでユーザー作業を待つ場合は `NEEDS_USER_ACTION` とし、User Action Required セクションに詳細を記載する。
- Changes テーブルには実際に編集・作成したファイルのみを記載する。
- 検証コマンドを実行した場合は Verification セクションに結果を記載する。
- このレポートとは別に、GitHub Issue body の `## 🐢 履歴` に 1-3 行のサマリを追記する。
