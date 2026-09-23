## 目的

ユーザーが選択した候補を最小構成の draft Issue として起票する。

## 方針

### 1. label の確認・自動作成

```bash
gh label create kind/plan --repo <owner>/<repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true
```
### 2. Issue 作成

各選択候補について `gh issue create` で起票する。

- **本文はタイトル + `## 💭 背景` のみの最小構成**とする。完了条件・方針・ミッションは書かない
- 背景には走査根拠と企画の意図を自然に織り込む
- 重複チェックで注記がある場合は背景末尾に `関連: #N` を追記する

```bash
gh issue create --repo <owner>/<repo> \
  --title "<タイトル>" \
  --body "## 💭 背景

<背景本文（根拠を織り込む）>

## 🐢 履歴
" \
  --label "kind/plan"
```
### 3. Project 追加・Status 設定

`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。

```bash
gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json
gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>
```
### 4. 報告

起票結果を報告する:
- 各 Issue の URL、タイトル、Status
- 起票しなかった候補の一覧
- 次ステップの案内: 「具体化は `plan-create` の from-Issue フローで取り込めます」

## 出力

起票した Issue の一覧をセッションディレクトリの `issue-numbers.json` に保存する:

```json
[{ "number": 123, "title": "<タイトル>" }]
```

report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:
```json
{"key": "issue-numbers.json", "path": "<SESSION>/issue-numbers.json"}
```

## 注意事項

- ユーザーが選択しなかった候補を起票しない
- 本文に完了条件・方針・ミッションを含めない

## インプット

セッションディレクトリ: <SESSION>
