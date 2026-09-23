## 目的

draft-bodyで確定した本文で既存Plan Issueを更新し、変更サマリを残す。

## 手順

### 0. 事前ガード（req-2:315 — codeで検証、promptでは参考）

更新前に既存Issueの状態を検証する（logic-2:457 — Issue番号は `^[0-9]+$` で検証し `shellQuote` してから `gh` に渡す）:
```bash
ISSUE_NUMBER=$(cat '<SESSION>/issue-number.txt' | tr -d '[:space:]')
if ! echo "$ISSUE_NUMBER" | grep -qE "^[0-9]+$"; then echo "invalid issue number: $ISSUE_NUMBER" >&2; exit 1; fi
gh issue view "$ISSUE_NUMBER" --json state,labels,body,number,title,url --jq '{state,labels,body}'
```
- `state` が `CLOSED` なら abort
- Project Status が `done` の Issue は更新せず abort
- 分解済み親（Sub Issueを持つ）の場合は警告を提示し、子との整合性を確認してから進む
- `external/<repo>` ラベルが付与された Issue は対象repoが正しいか確認
（check でも同様の検証を code で行うため、ここでの失敗は check で fail として検出される）

### 1. 入力の読み込み

セッションディレクトリの `issue-body.md`、`body-diff.md`, `evidence.json` を読み込む。

### 2. 楽観的ロック（logic-2:321 — codeでも検証）

編集直前に現行本文のハッシュを取得し、edit前に再比較する（darwin 対応: sha256sum → shasum -a 256 フォールバック）:
```bash
SHA_CMD=$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")
BEFORE_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)
DRAFT_BODY_HASH=$($SHA_CMD '<SESSION>/issue-body.md' | cut -d' ' -f1)
CURRENT_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)
if [ "$BEFORE_BODY" != "$CURRENT_BODY" ]; then echo "競合検出: 他者がIssueを更新しました。中断して body-diff を再生成してください" >&2; exit 1; fi
```
不一致なら中断し、draft-body に戻って body-diff を再生成する。（check でも hash 比較を再検証する）

### 3. Issue 本文の更新

```bash
gh issue edit "$ISSUE_NUMBER" --body-file '<SESSION>/issue-body.md'
```
失敗時はリトライ前に `gh issue view --json body` で本文が更新済みか確認し、冪等性を担保する。

### 4. 変更サマリの投稿（秘密マスキング: ai-2:330 — codeでも再検証）

投稿前に secret スキャンを実行し、トークン・APIキー・内部URLをマスキングしてから投稿する:
```bash
sed -E 's/(gh[pous]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpras]-[A-Za-z0-9-]+|npm_[A-Za-z0-9_]+|Bearer [A-Za-z0-9._-]+|-----BEGIN.*PRIVATE KEY-----)/***REDACTED***/g' '<SESSION>/summary.md' > '<SESSION>/summary.masked.md'
gh issue comment "$ISSUE_NUMBER" --body-file '<SESSION>/summary.masked.md'
```
投稿は最小権限トークンで実行し、内容は人間が承認した差分サマリのみとする。（check でマスキング漏れを再スキャンする）
マスク済みサマリを `summary.masked.md` として保存したことを report 時の `artifacts` に含める（申告漏れは check で fail になる）:
```json
[{"key": "issue-number.txt", "path": "<SESSION>/issue-number.txt"}, {"key": "summary.masked.md", "path": "<SESSION>/summary.masked.md"}]
```

### 5. ラベル付与

`plan:update` ラベルが存在しなければ作成し、Issueに付与する:
```bash
gh label view "plan:update" --json name >/dev/null 2>&1 || gh label create "plan:update" --description "計画更新" --color "0e8a16"
gh issue edit "$ISSUE_NUMBER" --add-label "plan:update"
```
失敗時は本文更新は成功しているため、ラベル付与のみリトライする。コメント重複投稿を避けるため、直前のコメント一覧を `gh issue view --json comments` で確認し、同一サマリが既に投稿済みならスキップする。
既存の `kind/plan` ラベルは維持する。

### 6. Issue番号の記録

更新したIssue番号を `issue-number.txt` に記録する（reportで参照）。
```bash
echo "$ISSUE_NUMBER" > '<SESSION>/issue-number.txt'
```

## 成果物

report 時の `artifacts` に以下を含める:
```json
{"key": "issue-number.txt", "path": "<SESSION>/issue-number.txt"}
```

## セッション情報

- セッションディレクトリ: <SESSION>
