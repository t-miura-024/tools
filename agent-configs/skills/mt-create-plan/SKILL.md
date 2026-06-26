---
name: mt-create-plan
description: Cursor Plan モードに依存せず、GitHub Issue として計画ファイルを新規作成・リファインメントする。from-Issue フロー (既存 Issue を plan 化) もサポート。ユーザーが「mt-create-plan」「計画作成」「計画を具体化」などを入力した時に使用する。
---

# mt-create-plan

GitHub Issue ベースで計画作成・リファインメントするパートナーとして振る舞い、実行は行わない。実行は `mt-run-plan` の責務。

## 共有資材

隣接する `mt-plan/` 配下の以下を参照する。いずれかが存在しない場合は中断する。

- `plan-format.md` — Issue body の本文フォーマット
- `list-plans.ts` — 既存計画 Issue の一覧取得
- `transition-plan.ts` — ステータス遷移（`draft` → `refined` etc.）
- `init-config.ts` — `~/.config/mt-plan/config.json` の読み込み（Project ID, Status field ID 等）

`~/.config/mt-plan/config.json` が存在しない場合は、`mt-plan init` の実行を案内して中断する。

## 🏃 ステップ

### 1. Grill Phase

この計画のあらゆる側面について、私たちが共通の認識に達するまで、徹底的に私に質問を投げかけてください。

設計のツリーを枝分かれの先まで一つひとつたどり、決定事項間の依存関係を順番に解決していきましょう。

ユーザーに質問する際は、本文内で番号付きの 3 つの選択肢を提示してください。各選択肢には 5 段階の推奨度（例: ★★★★☆）と理由を添え、あなたが最も推奨する回答が分かるようにしてください。自然な候補が 3 つに満たない場合も、自由記述・その他・保留などの具体的な第 3 案を作ってください。

質問は一度に 1 つずつお願いします。もしコードベースを探索することで答えが得られる質問であれば、質問する代わりにコードベースを調査してください。

#### 役割分担

- **ユーザー決定領域:** 背景、why、意図、制約、好み、避けたいこと — 推測で埋めず、必ず質問で確認する
- **AI 提案領域:** 完了条件、アウトプット、方針、解決策 — 調査・考察に基づき、選択肢・推奨度・理由を添えて提案する

#### 終了条件

Grill Phase はユーザーが明示的に「十分」と宣言するまで継続する。質問回数に固定上限を設けない。認識が不十分なまま次ステップへ進まない。

#### from-Issue フローの場合

Grill Phase 開始前に「既存 Issue を取り込みますか？」と質問する。Yes の場合:

1. ユーザーから `URL` / `#<number>` / `--from-issue <ref>` のいずれかで Issue 参照を受け取る
2. `gh issue view <ref> --json number,title,body,state,repository` で Issue メタデータを取得
3. 既に `kind/plan` label を持つ場合は「この Issue は既に plan です (status: <current>)。上書き / 中止？」と確認
4. 既存 body は「参考: 既存 Issue #<n> の body はこんな内容です」と表示する（Grill Phase の pre-fill には使用しない、Q25 決定）
5. 通常の Grill Phase に進む

### 2. 対象 repo の決定

Grill Phase 完了後、計画を作成する対象 GitHub repo を決定する。

1. `gh repo view --json nameWithOwner` で現在ディレクトリの repo を確認
2. 決定ロジック:
   - repo の owner が `t-miura-024` → その repo をそのまま使用
   - それ以外 → `t-miura-024/note` を対象 repo とし、`external/[repo-name]` label を付与
3. 決定した repo と分岐理由を表示

### 3. label の確認・自動作成

対象 repo に `kind/plan` label が存在するか確認する。

```bash
gh label list --repo <target-repo> --json name --jq '.[].name' | grep -q '^kind/plan$'
```

存在しない場合は自動作成:

```bash
gh label create kind/plan --repo <target-repo> --description "mt-plan で管理する計画 Issue" --color "0E8A16"
```

`external/[repo-name]` label が必要な場合（Q3 で外部 repo 扱いの場合）も同様に確認・自動作成:

```bash
gh label create "external/<repo-name>" --repo <target-repo> --description "External plan for <repo-name>" --color "D93F0B"
```

### 4. 計画 Issue の作成

Grill Phase の回答をもとに、`plan-format.md` に従って Issue body を組み立てる。`# 計画タイトル` は Issue title と重複するため body には含めない (Q5 決定)。

```bash
gh issue create \
  --repo <target-repo> \
  --title "<計画タイトル (日本語、date prefix なし)>" \
  --body "<組み立てた Issue body>" \
  --label "kind/plan" \
  --label "external/<repo-name>" \
  --project "<project-title-or-number>"
```

`--project` フラグの値:
- プロジェクト名で指定 (例: `--project "plans"`)
- 数値のみ (現在の owner の Project の場合、例: `--project "4"`)
- URL slug 形式 (例: `--project "https://github.com/users/t-miura-024/projects/4"`) は gh CLI のバージョンによって挙動が異なるため避ける

`~/.config/mt-plan/config.json` の `projectNumber` (例: 4) を使って `--project "4"` で指定するのが安定。

`from-Issue` フローの場合は、既存 Issue の URL/番号を使って更新:

```bash
gh issue edit <number> --repo <target-repo> \
  --title "<新しい title>" \
  --body "<新しい body>" \
  --add-label "kind/plan"
```

`external/<repo-name>` label が必要な場合は追加:

```bash
gh issue edit <number> --repo <target-repo> --add-label "external/<repo-name>"
```

### 5. Project への追加・Status 設定

`gh issue create` の `--project` フラグで Project 追加と同時にドラフト的に登録される。次に Status を `draft` に設定:

```bash
gh api graphql -H 'GraphQL-Features: project_v2' -f query='...' -f projectId='...' -f itemId='...' -f fieldId='...' -f optionId='<draft option id>'
```

`optionId` は `~/.config/mt-plan/config.json` の `statusOptions.draft` から取得。

または `transition-plan.ts` の `refined` への遷移で必要な `itemId` を取得するため、Project 追加後の GraphQL query で `itemId` を取得する。

### 6. 変更プレビュー・ユーザー確認 (from-Issue フローのみ)

`from-Issue` フローの場合、既存 Issue を変更する前に以下をプレビューして y/n 確認:

```
以下の変更を既存 Issue #<n> に適用します:
  + Add label: kind/plan
  + Add to Project: <owner>/<project-number>
  + Set Status: draft
  ~ Replace body: <new body> (current: <old body 先頭 100 文字>)
  = Keep title: <既存 title> | ~ Update title: <new title>
```

y で実行、n でキャンセル。

### 7. 作成内容の報告

ユーザーに以下を報告:

- 作成された Issue の URL・番号
- 対象 repo（`external/<repo>` label 使用の有無）
- Project URL
- 現在の Status (`draft`)
- 自動作成された label（あれば）
- 次のステップの案内:
  - `refined` への昇格準備ができるまで `## 🐿️ メモ` の `🤔 論点` を解消
  - 完了したら `mt-plan` を経由して `refined` への昇格を確認

### 8. Refined 昇格

1. Refined 昇格の判定基準を満たす場合、ユーザーに昇格を確認する。承認されたら `transition-plan.ts` で `refined` へ遷移する
2. 不足があれば `draft` のまま残し、次回確認事項を計画内に明記する

```bash
bun <mt-plan-skill-dir>/transition-plan.ts <number> refined
```

## ✅ 完了条件

- 計画 Issue が `plan-format.md` に従って作成されている
- Issue body に `# 計画タイトル` を含まない（Issue title と重複を避ける）
- 対象 repo に `kind/plan` label が付与されている（必要に応じて自動作成）
- 外部 repo の場合は `external/<repo-name>` label が付与されている
- Project に追加され、Status が `draft` に設定されている
- ユーザーが Issue 内容を承認し、`refined` への昇格が完了している、または `draft` のまま次回確認事項が明記されている

## 📦 アウトプット

- 作成・更新された計画 Issue（GitHub URL）
- 自動作成された label（`kind/plan`, `external/<repo-name>` 等）
- 次のステップ（`mt-run-plan` で実行）に関するユーザーへの案内

## ⚠️ 注意事項

- 直接 `gh issue create` 等で Issue を作成せず、本 Skill 経由で作成する
- `draft` の Issue を `mt-run-plan` で実行させない。先に `refined` へ昇格させる
- 既存 Issue を from-Issue フローで変更する場合、メモ・履歴を消す前にユーザーに警告する
- `kind/plan` label の自動作成は冪等（既存ならスキップ、なければ作成）
- 外部 repo 判定の `t-miura-024` チェックは case-sensitive で行う
