transition-plan.ts を実行して計画 Issue を `done` へ遷移させ、計画を完了する。

## 手順

1. done-gate step でユーザーが「Done にする」を承認したことを確認する。
2. transition-plan.ts を実行して done へ遷移する:
   ```bash
   bun ~/.takt/scripts/transition-plan.ts <number> done
   ```
3. 遷移結果を確認する:
   - 成功: `Transition succeeded` と報告する。`transition-plan.ts` が Issue を close し、`## 🐢 履歴` に自動追記する。
   - 失敗: エラーメッセージを報告する。
4. `## 🐢 履歴` に全完了のサマリを追記する（必要に応じて）。

## 出力

遷移結果（成功/失敗）、Issue 番号、最終ステータス（done）、Issue URL を報告する。

## 終了判定

- 遷移成功: `[STEP:0]` タグを出力。
- 遷移失敗: `[STEP:1]` タグを出力（ABORT）。
