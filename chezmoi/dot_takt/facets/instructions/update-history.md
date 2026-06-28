GitHub Issue body の `## 🐢 履歴` セクションに実行サマリを追記する。

## 手順

1. `gh issue view <number> --json body` で現在の Issue body を読み込む。
2. `## 🐢 履歴` セクションに以下の形式でエントリを追加する:
   ```
   - YYYY-MM-DD HH:mm [status] {実行サマリ（1-3行）}
   ```
3. 更新した body を `gh issue edit --body-file` で保存する。
4. 必要に応じて `## 🐿️ メモ` にも重要な判断材料を追記する。

## 更新タイミング

- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行）。
- 実行結果の確認後: `## 🐢 履歴` へ結果を追記。
- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記。
- 中断時: 次回再開位置と残論点を履歴かメモへ残す。
- レビューラウンドごと: `## 🐢 履歴` に指摘件数サマリを追記。
  ```
  - YYYY-MM-DD HH:mm [review N] must X件, should Y件, want Z件
  ```

## 注意

- 更新前は必ず `gh issue view` で body を読み、他者の差分を上書きしない。
- 詳細な実行記録は TAKT のレポートファイル（output_contracts）に任せ、Issue body の履歴は簡潔なサマリに留める。
- 状態遷移時の履歴エントリ（`- YYYY-MM-DD HH:mm [target-status] source-status から遷移`）は `transition-plan.ts` が自動追記する。
