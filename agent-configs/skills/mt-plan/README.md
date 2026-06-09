# mt-plan 共有資材

`mt-create-plan`、`mt-run-plan`、`mt-plan` で共有する計画管理用の資材を置くディレクトリです。
各 Skill の `SKILL.md` には共有資材の本文を重複させず、このディレクトリ配下のファイルを参照します。

## ファイル

- `plan-format.md`: 計画ファイルの本文フォーマット。
- `list-plans.ts`: `.gitignore` の影響を受けずに `tmp/plan/[status]/*.md` を列挙するスクリプト。
- `list-plans.test.ts`: 計画一覧スクリプトの Vitest。
- `transition-plan.ts`: `tmp/plan/[status]/` 間で計画ファイルを移動する状態遷移スクリプト。
- `transition-plan.test.ts`: 状態遷移スクリプトの Vitest。

## 計画一覧

`tmp/plan/` はプロジェクトの `.gitignore` で ignore 対象になり得ます。
計画候補の一覧取得では `Glob` / `rg` の結果だけに依存せず、`list-plans.ts` でファイルシステムから直接列挙します。

```bash
bun <mt-plan-skill-dir>/list-plans.ts --cwd <project-root> refined in-progress
```

主な用途は以下です。

- `mt-run-plan`: `refined` / `in-progress` の実行候補一覧
- `mt-create-plan`: `draft` / `refined` の既存計画確認

## 状態遷移

状態遷移は `transition-plan.ts` を使います。
`mv` や手動のファイル移動で `tmp/plan/[status]/` 間を移動してはいけません。
実行時は、現在読み込んでいる `mt-plan` Skill ディレクトリ内の `transition-plan.ts` を指定します。

```bash
bun <mt-plan-skill-dir>/transition-plan.ts tmp/plan/refined/20260425-example.md in-progress
```

許可される遷移は以下です。

- `draft` → `refined`
- `refined` → `in-progress`
- `in-progress` → `done`
- `done` → `in-progress`

## テスト

共有スクリプトを変更した場合は、次のコマンドでテストします。

```bash
npm test -- <mt-plan-skill-dir>/list-plans.test.ts <mt-plan-skill-dir>/transition-plan.test.ts
```
