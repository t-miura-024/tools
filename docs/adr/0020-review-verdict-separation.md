---
status: accepted
---

# 敵対的検証ワークフローは verdict までで終端し修正ループは消費者が所有する

## 背景 (Context)

旧 `mt-plan-run` の `review_work` は hunk セッション開始から findings 集約、verdict 判定、`workflow.db` の `resetReviewCycle` によるループ制御までを一体で担っていた。単独で敵対的検証を起動したい場合にもループ制御が巻き込まれ、再利用時に状態破壊が起きる構造であった。Issue の完了条件 2 は「単独起動は修正ループを持たず、plan-run が loop を所有」することを求めている。

grill で「検証 Step は hunk と findings/verdict にのみ副作用を持ち、workflow.db に触れない」原則が合意された。検証ワークフローは純粋に指摘と判定を生成し、修正の反復は呼び出し元が決定すべきという責務分離が求められた。

## 決定 (Decision)

検証 Step は hunk セッションと findings/verdict アーティファクトにのみ副作用を持ち、workflow.db のループ制御（`resetReviewCycle` 相当）に触れないこととした。`mt-review-diff` は `collect_verdict` で verdict.json を出力して終端し、修正ループは消費者（`mt-plan-run` の `execute_work` 等）が所有する。

アーティファクト契約: `findings.json`（axis/severity/detail/position）と `verdict.json`（passed/blocked/blocking_threads/round）がワークフロー間の唯一のインターフェースとなる。ラウンド上限 3 の判定は `collect_verdict` で行い、上限到達時は human_gate で継続/中止を選択するが、DB のリセットは消費者が行う。

## 代替案 (Considered Options)

- 検証ワークフローがループ制御まで所有する方式: 検証と修正が密結合し、単独起動時にも不要なループ状態が生成される。単独起動と計画内検証で挙動が分岐しテストが複雑化するため不採用。
- `resetReviewCycle` を検証ワークフロー内に残しつつ、条件分岐で単独起動時はスキップする方式: 分岐がワークフロー内に漏出し、呼び出し元の意図が検証側に侵入する。責務境界が曖昧になるため不採用。
- 完全に別ワークフローとしてループ専用ワークフローを新設する方式: 概念的には綺麗だが、tado のワークフロー起動コストと human_gate の二重化が発生し、tracer bullet の最小構成に反するため見送り。

## 帰結 (Consequences)

- `mt-review-diff` は再利用時に状態破壊を起こさず、単独起動でも計画内でも同一の検証結果を返す。テストはアーティファクトのスキーマ検証と純粋関数の単体テストで担保できる。
- 修正ループの所有が `mt-plan-run` に集約され、`execute_work` が verdict の blocking_threads を参照して反復を制御する。責務が明確化される。
- 検証ワークフロー単体では「指摘して終わり」となるため、利用者は verdict を読んで手動修正するか、plan-run のループに委譲するかを選択する運用になる。
- workflow.db への副作用が検証側から除去されたことで、並列実行やリトライ時の再現性が向上する。
