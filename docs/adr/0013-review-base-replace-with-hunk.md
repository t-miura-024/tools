---
status: accepted
---

# レビュー基盤を difit から hunk へ置換

difit は Web UI ベースでエージェント連携に難があり、ゲート判定・スレッド等の独自概念（選択キー / commentImports / resolve）が運用上の負担になっていた。ターミナル TUI の diff viewer である hunk（modem-dev/hunk）へ置換し、`mt difit` を `mt hunk` にリネームする。コメントは行紐づきのフラット構造になり、ゲート判定は「未解決 AI コメント残存 + 人間コメント残存」で行い、AI コメントの削除（rm）を解決とみなす。`[context]` taxonomy と contextNotes は廃止し、want 指摘はノンブロッキングとして同一行に人間コメントが付いた場合のみ修正対象とする。untracked は hunk のデフォルト機能（ADR-0009 廃止）、レビュー対象は hunk の revset 直渡し（ADR-0008 廃止）、ファイルレベル指摘は newLine: 1 合成（ADR-0011 廃止）で代替する。
