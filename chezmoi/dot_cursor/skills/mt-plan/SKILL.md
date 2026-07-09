---
name: mt-plan
description: Cursor Plan モードに依存せず、GitHub Issue ベースの計画作成から実行までを進める統合入口。ユーザーが「mt-plan」「計画を作って進める」「計画作成から実行まで」などを入力した時に使用する。
---

# mt-plan

Cursor Plan モードに依存せず、GitHub Issue ベースの計画作成から実行までを一続きで扱う統合 Skill です。
個別フェーズの詳細は `mt-create-plan` と `mt-run-plan` に委譲し、この Skill は入力ルーティング、フェーズ接続、ユーザー確認に責務を限定します。

## 🧠 前提知識

- 計画保存先: GitHub Issue + GitHub Project (v2)。1 plan = 1 Issue。
- ステータス: GitHub Project の Status custom field (`draft` → `refined` → `in-progress` → `done`)
- Project: ユーザー/Organization レベル (例: `https://github.com/users/t-miura-024/projects/4`)
- 設定: `~/.config/mt-plan/config.json` (Project ID, Status field ID, option ID 等)
- Skill 配置ルート: 現在読み込んでいる `mt-plan/SKILL.md` のディレクトリを共有資材の場所として扱う
- 計画フォーマット: この Skill ディレクトリの `plan-format.md`
- 計画一覧: この Skill ディレクトリの `list-plans.ts` (Project query)
- 状態遷移: この Skill ディレクトリの `transition-plan.ts` (Project Status 更新 + Issue open/closed 同期)
- 設定初期化: この Skill ディレクトリの `init-config.ts` (Project field-list から config 生成)
- 共有資材: 現在読み込んでいる `mt-plan/` Skill ディレクトリ配下を Source of Truth とする
- 関連 Skill: `mt-create-plan`（計画作成・リファインメント）, `mt-run-plan`（計画実行・履歴更新）

## 🚦 Plan First ルール

`/mt-plan` または計画作成が求められている依頼では、承認済み計画が存在するまで実行しない。
ファイル編集・状態遷移・外部副作用のあるコマンドは、以下を満たしてから行う。

1. 実行対象の計画 Issue が存在し、`refined` または `in-progress` ステータスである
2. ユーザーがその計画の実行を明示している
3. これから行う作業が承認済み計画の範囲内である

「改善案 N で良い」「この方針で良い」などの選択表明は、実装承認ではなく計画内容への入力として扱う。
実行へ進むには、計画作成後の Human Gate で明示的に承認を得る。

## 🏃 ステップ

あなたは計画作成から実行までをつなぐオーケストレーターとして振る舞ってください。
ユーザーの入力に対して、以下の処理を行ってください。

### 1. 共有資材と個別 Skill の確認

以下のファイルを Read ツールで確認する。

1. 現在読み込んでいる `mt-plan/SKILL.md` と同じディレクトリの `README.md`
2. 現在読み込んでいる `mt-plan/SKILL.md` と同じディレクトリの `plan-format.md`
3. 現在読み込んでいる `mt-plan/SKILL.md` と同じディレクトリの `list-plans.ts`
4. 現在読み込んでいる `mt-plan/SKILL.md` と同じディレクトリの `transition-plan.ts`
5. 現在読み込んでいる `mt-plan/SKILL.md` と同じディレクトリの `init-config.ts`
6. 関連 Skill `mt-create-plan` の `SKILL.md`
7. 関連 Skill `mt-run-plan` の `SKILL.md`

共有資材または個別 Skill が存在しない場合は、不足しているファイルをユーザーに報告して中断する。
`~/.config/mt-plan/config.json` が存在しない場合は、`mt-plan init` の実行を案内して中断する。

### 2. 入力ルーティング

ユーザー入力と既存計画の状態から、開始地点を判定する。

| 入力 | 開始地点 |
| ---- | ---- |
| 新規計画の目的・背景・作りたいものがある | Step 3（計画作成） |
| `draft` ステータスの計画 Issue が指定されている | Step 3（計画リファインメント） |
| `refined` または `in-progress` ステータスの計画 Issue が指定されている | Step 5（計画実行） |
| 入力が曖昧、または計画作成か実行か判断できない | 本文で開始地点の選択肢を番号付きで提示して確認 |

Issue の指定は URL / `#<number>` / `<number>` のいずれかで受け付ける。

改善案・方針・選択肢への同意が含まれていても、承認済み計画がまだ存在しない場合は Step 3（計画作成）から始める。
入力がない場合は、まず作成したい計画の目的・背景・期待する成果を本文で確認し、Step 3 へ進む。

### 3. 計画作成・リファインメント

関連 Skill `mt-create-plan` の `SKILL.md` を Read して実行する。

`mt-create-plan` の責務に従い、以下を完了させる。

- 計画 Issue の新規作成または既存 Issue の plan 化 (from-Issue フロー)
- 背景、完了条件、アウトプット、方針、未決事項の整理
- 背景、why、意図、制約など、ユーザーが決定主体の情報のすり合わせ
- 背景情報をもとにした、AI 主体の完了条件・アウトプット・方針・解決策の提案
- `draft` から `refined` への昇格可否の確認
- `kind/plan` label 自動作成 (対象 repo に存在しない場合)
- 対象 repo の決定 (`t-miura-024` 配下ならそのまま、それ以外は `t-miura-024/note` + `external/[repo-name]` label)

この Step では計画実行の詳細手順を独自に実装しない。
また、計画作成前の認識合わせ手順を独自に短縮せず、`mt-create-plan` の背景ヒアリングと提案責務に従う。

### 4. 実行へ進むか確認

`mt-create-plan` 完了後、作成・更新された計画の現在ステータスを確認する。

**`refined` の場合:**

本文で番号付き選択肢を提示し、続けて実行へ進むか確認する。

- 実行へ進む
- ここで終了する

「実行へ進む」が選択された場合は Step 5 へ進む。
「ここで終了する」が選択された場合は、計画 Issue の URL と現在ステータスを報告して終了する。

**`draft` の場合:**

未解決事項または不足情報が残っているため実行へ進めないことを伝え、次に確認すべき内容を報告して終了する。

### 5. 計画実行

関連 Skill `mt-run-plan` の `SKILL.md` を Read して実行する。

`mt-run-plan` の責務に従い、以下を処理する。

- `refined` または `in-progress` の計画 Issue 選択（インタラクティブ or Issue 番号）
- `refined` から `in-progress` への状態遷移（`transition-plan.ts` 使用）
- 方針に基づく直接実行またはガイド
- Issue body の `## 🐢 履歴` への追記（実行結果、判断、中断理由など）
- Done 化前の完了条件確認（SubAgent レビュー）

この Step に入れるのは、Step 4 でユーザーが実行を明示承認した場合だけとする。
計画外の作業が必要になった場合は実行を止め、計画修正または再承認へ戻る。
この Step では計画作成・リファインメントの詳細手順を独自に実装しない。

### 6. 終了報告

終了時に、以下を簡潔に報告する。

- 対象計画 Issue の URL・番号
- 現在のステータス (`draft` / `refined` / `in-progress` / `done`)
- 完了した作業
- 残っている未決事項
- 次に必要なアクション

## ✅ 完了条件

- `mt-create-plan` と `mt-run-plan` の連続実行手順が定義されている
- 計画作成後に実行へ進むか確認する Human Gate がある
- 実行可能な計画だけが `mt-run-plan` に渡される
- 共有資材の Source of Truth が現在読み込んでいる `mt-plan/` Skill ディレクトリ配下として明記されている
- 計画作成・計画実行の詳細責務が個別 Skill に委譲されている

## 📦 アウトプット

- 作成・更新された計画 Issue (GitHub URL)
- 実行された計画 Issue の `## 🐢 履歴` 更新
- 計画作成から実行までの進捗報告
- 中断時の現在ステータスと次アクション

## ⚠️ 注意事項

- `SKILL.md` に計画フォーマット本文を重複させない
- 状態遷移は `transition-plan.ts` を使い、`gh project item-edit` 等の直接呼び出しをしない
- `mt-plan` は統合入口に集中し、`mt-create-plan` と `mt-run-plan` の詳細手順を複製しない
- `draft` の計画は実行せず、先に `mt-create-plan` で `refined` へ昇格できる状態まで整理する
- 計画実行へ進む前に、必ずユーザー確認を挟む
- 承認済み計画が存在しない状態で、実装・編集、状態遷移を開始しない
- `config.json` が未設定の場合は `mt-plan init` を案内する
- `kind/plan` label は対象 repo に存在しなければ `mt-create-plan` 実行時に自動作成
