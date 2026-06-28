選択された計画 Issue（refined ステータス）を `in-progress` へ遷移させ、実行を開始する。

## 手順

1. select-plan step で選択された Issue 番号を取得する。
2. `~/.config/mt-plan/config.json` が存在するか確認する。存在しない場合は `bun ~/.takt/scripts/init-config.ts --owner <owner> --project <number>` の実行を案内して ABORT する。
3. transition-plan.ts を実行して in-progress へ遷移する:
   ```bash
   bun ~/.takt/scripts/transition-plan.ts <number> in-progress
   ```
4. 遷移結果を確認する:
   - 成功: `Transition succeeded` と報告する。`transition-plan.ts` が `## 🐢 履歴` に自動追記する。
   - 失敗: エラーメッセージを報告する。
5. 遷移後の Issue URL と Status を確認する。

## 出力

遷移結果（成功/失敗）、Issue 番号、新しいステータス（in-progress）を報告する。

## 終了判定

- 遷移成功: `[STEP:0]` タグを出力。
- 遷移失敗: `[STEP:1]` タグを出力（ABORT）。
