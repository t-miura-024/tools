# mt-plan 共有資材

`mt-create-plan`、`mt-run-plan`、`mt-plan` で共有する GitHub Issue / Project ベースの計画管理用の資材を置くディレクトリです。
各 Skill の `SKILL.md` には共有資材の本文を重複させず、このディレクトリ配下のファイルを参照します。

## ファイル

- `plan-format.md`: GitHub Issue body の本文フォーマット。
- `init-config.ts`: GitHub Project から `~/.config/mt-plan/config.json` を生成するスクリプト。
- `init-config.test.ts`: `init-config.ts` の Vitest。
- `init-config-gh.ts`: `init-config.ts` から呼び出される `gh` CLI 経由の GitHub API 呼び出し層。
- `list-plans.ts`: GitHub Project から計画 Issue を列挙するスクリプト (`refined` / `in-progress` デフォルト)。
- `list-plans.test.ts`: `list-plans.ts` の Vitest。
- `transition-plan.ts`: 計画 Issue の Status custom field を更新し、Issue open/closed を同期し、`## 🐢 履歴` に追記する状態遷移スクリプト。Sub Issue の遷移後は親の状態も集約する。
- `transition-plan.test.ts`: `transition-plan.ts` の Vitest。

## 計画一覧

GitHub Project (v2) を Source of Truth とし、Status custom field でフィルタリングして Issue を列挙します。
`list-plans.ts` は `gh api graphql` で Project の items を取得し、Status 値で絞り込みます。

```bash
bun <mt-plan-skill-dir>/list-plans.ts refined in-progress
# default は refined in-progress、省略可能
```

主な用途は以下です。

- `mt-run-plan`: `refined` / `in-progress` の実行候補一覧（インタラクティブ選択）
- `mt-create-plan`: 既存計画確認

## 状態遷移

状態遷移は `transition-plan.ts` を使います。
Project の Status custom field を更新し、Issue open/closed を同期し、`## 🐢 履歴` に追記します。

```bash
bun <mt-plan-skill-dir>/transition-plan.ts 7 in-progress
# Plan #7 を in-progress に遷移
```

遷移の順序は `workflow.ts` のステップ定義で管理します。`transition-plan.ts` は GitHub Project / Issue の更新を実行する層です。

## 分解計画

親子構造は GitHub Sub Issue 関係だけを Source of Truth とし、1 階層に限定します。親は実行不可の集約ノードです。子を `in-progress` にすると最初の子で親も `in-progress` へ、全子を `done` にすると親も `done` へ、`transition-plan.ts` が自動遷移します。GitHub UI から直接変更した状態は集約しません。集約判定中の GitHub UI による並行 Status 更新はサポートしません。

## 旧形式の計画

`tmp/plan/[status]/yyyymmdd-[plan-name].md` の既存 Markdown は履歴として残っていますが、現行の `list-plans.ts` と `transition-plan.ts` は扱いません。新規計画と状態遷移には GitHub Issue / Project ベースの資材を使用してください。

## 設定初期化

`init-config.ts` で `~/.config/mt-plan/config.json` を生成します。
GitHub Project の field 一覧を取得し、Status custom field の option ID を保存します。

```bash
bun <mt-plan-skill-dir>/init-config.ts
# ~/.config/mt-plan/config.json に Project ID, Status field ID, option ID を保存
```

`gh` CLI の `project` scope が必要です。事前に `gh auth refresh -s read:project,project` を実行してください。

## テスト

共有スクリプトを変更した場合は、次のコマンドでテストします。

```bash
cd <mt-plan-skill-dir>
bun x vitest run
```
