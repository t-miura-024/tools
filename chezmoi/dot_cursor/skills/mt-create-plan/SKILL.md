---
name: mt-create-plan
description: Cursor Plan モードに依存せず、GitHub Issue として計画ファイルを新規作成・リファインメントする。from-Issue フロー (既存 Issue を plan 化) もサポート。ユーザーが「mt-create-plan」「計画作成」「計画を具体化」などを入力した時に使用する。
---

# mt-create-plan

GitHub Issue ベースで計画作成・リファインメントを行う。実行は `mt-run-plan` の責務。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `plan-format.md` — Issue body の本文フォーマット
- `list-plans.ts` — 既存計画 Issue の一覧取得
- `transition-plan.ts` — ステータス遷移
- `init-config.ts` — 設定読み込み
- `workflow.ts` — mt-run-plan 実行時のワークフロー定義

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## 🏃 ステップ

### 1. Grill Phase

計画の全側面について共通認識に達するまで質問を繰り返す。

- **ユーザー決定領域:** 背景、why、意図、制約 — 推測で埋めず質問で確認
- **AI 提案領域:** 完了条件、アウトプット、方針、解決策、実行単位の分割 — 選択肢・推奨度・理由を添えて提案
- 文書を残しながら詰める場合は `mt-grill-with-docs` を使う（用語は `CONTEXT.md`、覆しにくい判断は ADR）
- 確認が済むまで Issue 作成や状態遷移を進めない

質問は一度に1つ。ユーザーが「十分」と宣言するまで継続。

#### from-Issue フロー

開始前に「既存 Issue を取り込みますか？」と確認。Yes の場合は Issue メタデータ取得後、通常の Grill Phase へ。

### 1b. 縦切り分解が必要な場合

大きな計画を実行可能な単位へ割るときは、次を守る:

- 各単位は 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする
- 単独で確認できる振る舞いを持つ
- 依存する他単位を `Blocked by` として明示する
- 広く機械的な置換だけは expand-contract で別扱いする

### 2. 対象 repo の決定

1. `gh repo view --json nameWithOwner` で repo を確認
2. owner が `t-miura-024` → そのまま。それ以外 → `t-miura-024/note` + `external/<repo>` label

### 3. label の確認・自動作成

`kind/plan` label がなければ自動作成。`external/<repo>` label も同様。

### 4. 分解判定と Human Gate

Grill Phase の後、作成対象の最終本文（`## 🧩 実行単位` を含む）と分解要否を提示し、Issue を作成する前にユーザーの明示的な承認を得る。承認がなければ Issue を作成しない。

承認ゲートでは、作成と合わせて refined 昇格の要否を一度に確認する。選択肢:

1. **作成して refined へ（既定）** — 内容が完成・実行可能。作成後すぐに refined へ昇格する
2. **draft のまま作成** — 記録するが未確定。後で練り直す・他人に確認してもらう
3. **修正** — 本文を修正してから再度承認する

未解決の `🤔 論点` や完了条件の不足がある場合は「draft のまま作成」を推奨する。

draft 計画が複数の機能・領域を含み、単一 Issue では独立した完了条件と進捗を管理できない場合は、分解が必要な理由と親・子の計画案を提示する。

- 子計画は 1 階層までとし、再分解しない
- 子の目的・対応スコープの和集合が親計画を過不足なく満たすことを、重複と漏れの観点で確認する
- 親子 Issue の作成前に、分解案と各子の draft 本文についてユーザーの明示的な承認を得る（refined 昇格の要否も同時に確認する）
- 承認がなければ、親子 Issue を作成しない
- 分解計画の制約詳細は `plan-format.md` の分解計画セクションを参照

### 5. 計画 Issue の作成

`plan-format.md` に従い Issue body を組み立て、`gh issue create` で作成。Project に追加し Status を `draft` に設定（Project 追加時に draft が自動付与される）。

分解する場合は親子とも draft で作成し、GitHub REST API で Sub Issue 関係を設定する。親子構造は GitHub の Sub Issue 関係だけで管理し、本文に子 Issue 一覧を複製しない。

```bash
gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \
  -f sub_issue_id=<child-issue-id>
```

Step 4 で「作成して refined へ」が選ばれていれば、作成（分解の場合は Sub Issue 関係の設定）後に refined へ昇格する:

```bash
bun <mt-plan-dir>/transition-plan.ts <number> refined
```

分解計画は子を refined に遷移すると親も自動集約される（`transition-plan.ts` の親集約機能）。「draft のまま作成」が選ばれた場合は draft のまま残し、Step 6 で次回確認事項を報告する。

### 6. 作成内容の報告

Issue URL、repo、Project、Status、label を報告する。

- refined の場合: `mt-run-plan` で実行可能であることを案内する
- draft の場合: refined へ昇格するために必要な次回確認事項（未解決論点・不足）を明記する

## ✅ 完了条件

- 計画 Issue が `plan-format.md` に従って作成されている
- `kind/plan` label が付与されている
- Project に追加され、Status が適切に設定されている
- ユーザーが Issue 内容を承認し、作成時に refined 昇格の要否が決定されている
- 分解時は GitHub Sub Issue 関係が 1 階層であり、子計画が親計画の目的・スコープを過不足なく満たしている

## ⚠️ 注意事項

- 直接 `gh issue create` をせず、本 Skill 経由で作成する
- `draft` の Issue を `mt-run-plan` で実行させない
- `kind/plan` label の自動作成は冪等に行う
- 子計画の作成や refined への昇格は、作成承認ゲートでユーザーの明示的な承認を得てから行う
