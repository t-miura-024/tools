---
name: mt-resolve-merge-conflicts
description: 進行中の git merge または rebase 競合を、双方の意図を保って解消する。merge conflict、rebase conflict、競合解消と言われた時に使用する。
---

# マージ競合の解消

進行中の merge / rebase 競合を、双方の意図を保ったまま解消する。

## 🏃 ステップ

### 1. 現在状態を把握する

```bash
git status
git log --oneline --decorate -20
```

- 競合ファイル一覧と、merge か rebase かを確認する
- 競合解消を始める前に、目標（どちらを主にするか）を把握する

### 2. 各競合の一次情報を読む

- 競合 hunk の双方を読む
- 関連コミットメッセージ、PR、Issue を確認する
- 「なぜその変更が入ったか」を双方について把握する

### 3. hunk ごとに解消する

- 両立できるなら両方の意図を残す
- 両立できないなら、merge / rebase の目標に合う側を選び、トレードオフを記録する
- 新しい振る舞いを発明しない
- `--abort` せず、必ず解消する

### 4. 自動チェックを走らせる

プロジェクトの検証手段を探し、競合解消後に実行する:

1. typecheck / lint
2. 関連テスト
3. format

壊れたものがあれば直す。

### 5. 完了する

- 変更を stage する
- merge なら commit、rebase なら `git rebase --continue` を完走する
- 両立できなかった選択があれば、履歴または報告に残す

## ✅ 完了条件

- 競合マーカーが残っていない
- 双方の意図を可能な範囲で保持している
- プロジェクトの検証が通っている
- merge / rebase が完了している

## ⚠️ 注意事項

- 新しい仕様や振る舞いをその場で追加しない
- force-push や history 改変はユーザー指示がある場合のみ
