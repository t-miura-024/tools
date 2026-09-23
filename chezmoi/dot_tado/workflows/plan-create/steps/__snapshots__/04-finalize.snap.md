## 目的

作成した Refined Issue の内容を報告する。GitHub への変更は行わない（作成・refined 化は create-refined が完了済み）。
create-refined が Project 追加・refined 遷移で部分失敗した場合は本ステップから再開せず、issue-number.txt を起点に create-refined を再実行してから報告する。

## 完了条件

Issue URL・番号・対象 repo・Project・Status（refined）・label と `plan-run` 実行可能案内が報告されている

## 方針

### 1. Issue 番号の確認

セッションディレクトリの issue-number.txt から Issue 番号を読み取る。読み取る前に `grep -Eq '^[0-9]+$'` で検証し、不正なら GitHub操作へ進まず escalate する（失敗報告のみ）。
### 2. 作成内容の報告

以下を報告する:
- Issue URL・番号
- 対象 repo
- Project・Status（refined であること）
- label
- `plan-run` で実行可能であることを案内

## インプット

セッションディレクトリ: <SESSION>
