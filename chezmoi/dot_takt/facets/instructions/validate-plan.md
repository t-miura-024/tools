選択された計画 Issue を検証する。

## 手順

1. Issue 番号を取得する。取得方法は以下のいずれか:
   - `git branch --show-current` を実行し、ブランチ名 `takt/{issueNumber}/{slug}` から `{issueNumber}` を抽出する
   - 上記で取得できない場合、order.md（`{task}` で示されたパス）の1行目 `## Issue #{number}: {title}` から `{number}` を抽出する
2. `~/.config/mt-plan/config.json` が存在するか確認する。存在しない場合は `bun ~/.takt/scripts/init-config.ts --owner <owner> --project <number>` の実行を案内して ABORT する。
3. `gh issue view <number> --json state,labels` で Issue の存在と state を確認する。
4. `kind/plan` label が付与されているか確認する。
5. `bun ~/.takt/scripts/list-plans.ts` の出力で `refined` または `in-progress` ステータスか確認する（あるいは `gh issue view` と labels の情報から判定する）。
6. ステータスに応じて以下を実行する:
   - `draft` ステータス: 「先に計画を refined へ昇格させる必要があります」と案内して ABORT する（`[STEP:2]`）。
   - `done` ステータス（= close 済）: 「完了済みです。再開しますか？」と確認する。
     - Yes の場合: `bun ~/.takt/scripts/transition-plan.ts <number> in-progress` を実行し、`[STEP:1]` を出力（execute へ）。
     - No の場合: `[STEP:2]` を出力（ABORT）。
   - `refined` ステータス: `[STEP:0]` を出力（start-execution へ）。
   - `in-progress` ステータス: `[STEP:1]` を出力（execute へ）。

## 出力

検証結果（成功/失敗）、Issue 番号、タイトル、現在ステータス、次のステップを報告する。

## 終了判定

- `refined`: `[STEP:0]`
- `in-progress` または `done` から再開: `[STEP:1]`
- 実行不可: `[STEP:2]`（ABORT）
