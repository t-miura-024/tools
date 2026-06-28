実行対象の計画 Issue を選択する。

## 手順

1. `{task}` に Issue 番号が含まれる場合（`takt #N` で起動、または workflow_call から `issue_number` が渡された場合）:
   - 指定された Issue 番号をそのまま実行対象とする。
   - `gh issue view <number> --json state,labels` で Issue の存在と state を確認。
   - `kind/plan` label が付与されているか確認。
   - `bun ~/.takt/scripts/list-plans.ts` の出力で `refined` または `in-progress` ステータスか確認。
   - `draft` ステータスなら「先に mt-create-plan で refined へ昇格させる必要があります」と案内して ABORT。
   - `done` ステータス（= close 済）なら「完了済みです。再開しますか？」と確認。
2. Issue 番号が指定されていない場合:
   - `bun ~/.takt/scripts/list-plans.ts` で `refined` / `in-progress` の計画を一覧する。
   - 一覧を番号付き選択肢として提示し、ユーザーに選ばせる。
   - 表示形式: `1. [refined] サンプル計画 (#123) 2026-06-25`
   - 候補がなければ「実行可能な計画がありません。mt-create-plan で計画を作成してください」と報告して ABORT。

## 前提確認

- `~/.config/mt-plan/config.json` が存在しない場合は、`bun ~/.takt/scripts/init-config.ts --owner <owner> --project <number>` の実行を案内して ABORT。

## 出力

選択された計画 Issue の URL・番号・タイトル・現在ステータスを報告する。
