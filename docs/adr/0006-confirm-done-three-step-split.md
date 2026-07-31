---
status: accepted
---

# confirm_done を 3 ステップに分割

difit 統合には「起動」「待機」「判定」の 3 責務がある。tado の設計思想はステップ = 単一責務であるため、`start_difit_review`（task）+ `await_review`（human_gate）+ `check_difit`（task）に分割する。human_gate で自然に人間の「done」を待て、check_difit の check 関数で goto 判定ができる。
