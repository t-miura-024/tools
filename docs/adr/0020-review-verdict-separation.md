---
status: accepted
---

# 敵対的検証ワークフローは verdict までで終端し修正ループは消費者が所有する

## 背景 (Context)

旧 `mt-plan-run` の `review_work` は difit セッション開始から findings 集約、verdict 判定、`workflow.db` の `resetReviewCycle` によるループ制御までを一体で担っていた。単独で敵対的検証を起動したい場合にもループ制御が巻き込まれ、再利用時に状態破壊が起きる構造であった。Issue の完了条件 2 は「単独起動は修正ループを持たず、plan-run が loop を所有」することを求めている。

grill で「検証 Step は difit セッションと findings/verdict にのみ副作用を持ち、workflow.db に触れない」原則が合意された。検証ワークフローは純粋に指摘と判定を生成し、修正の反復は呼び出し元が決定すべきという責務分離が求められた。

## 決定 (Decision)

検証 Step は difit セッションと findings/verdict アーティファクトにのみ副作用を持ち、workflow.db のループ制御（`resetReviewCycle` 相当）に触れないこととした。`mt-review-diff` は `collect_verdict` で verdict.json を出力して終端し、修正ループは消費者（`mt-plan-run` の `execute_work` 等）が所有する。

アーティファクト契約: `findings.json`（axis/severity/detail/position）と `verdict.json`（passed/blocked/blocking_threads/round）がワークフロー間の唯一のインターフェースとなる。ラウンド上限 3 の判定は `collect_verdict` で行い、単独起動では fail で終端する。消費者である `mt-plan-run` は、上限到達時のみ human gate `round_limit_gate`（受容して完了 / もう1巡 / 中断）を提示し、それ以外の復旧不能な fail（セッション不在・突合不一致・done 非通過等）は `resetReviewCycle` で execute_work より後を pending に戻し、execute_work からの再実行で次ラウンドに復旧させる。

## 決定の補足: revise フィードバックの追跡（無音化防止）

人間ゲートの revise 入力を executor の修正指示へ確実に引き継ぐため、`mt-plan-run` の `execute_work` は次の契約で理由の欠落・混入を検出する。

- workflow.db（`~/.tado/workflow.db`）は全セッション共有のため、revise 理由の読み出しは `gate_events` を `session_id = <セッションディレクトリ basename>` かつ `event = 'confirmed'` で必ず絞る（`step_attempts.result_json` 経由でも `steps.session_id` で絞る）。絞らないと別 Issue の revise 入力が本セッションの修正指示として混入する。
- オーケストレーターは抽出結果を `revise-feedback.json`（`{"sessionId": "<session_id>", "items": [{"stepKey": "<gate step_key>", "reason": "<input 原文>"}]}`）に保存する。reason は要約・改変しない。対象の step_key は `await_human_review` / `round_stall_gate` / `round_limit_gate`。
- `execute_work` の check が workflow.db の confirmed revise と `revise-feedback.json` を突合し、欠落・余剰・sessionId 不一致・空 reason・読み取り不能を fail にする（revise があるのにファイルが無い経路を無音で通さない）。workflow.db を開けない場合は検証不能の warning を pass 理由に残し、無音にしない。

## 代替案 (Considered Options)

- 検証ワークフローがループ制御まで所有する方式: 検証と修正が密結合し、単独起動時にも不要なループ状態が生成される。単独起動と計画内検証で挙動が分岐しテストが複雑化するため不採用。
- `resetReviewCycle` を検証ワークフロー内に残しつつ、条件分岐で単独起動時はスキップする方式: 分岐がワークフロー内に漏出し、呼び出し元の意図が検証側に侵入する。責務境界が曖昧になるため不採用。
- 完全に別ワークフローとしてループ専用ワークフローを新設する方式: 概念的には綺麗だが、tado のワークフロー起動コストと human_gate の二重化が発生し、tracer bullet の最小構成に反するため見送り。

## 帰結 (Consequences)

- `mt-review-diff` は再利用時に状態破壊を起こさず、単独起動でも計画内でも同一の検証結果を返す。テストはアーティファクトのスキーマ検証と純粋関数の単体テストで担保できる。
- 修正ループの所有が `mt-plan-run` に集約され、`execute_work` が verdict の blocking_threads を参照して反復を制御する。責務が明確化される。
- 検証ワークフロー単体では「指摘して終わり」となるため、利用者は verdict を読んで手動修正するか、plan-run のループに委譲するかを選択する運用になる。
- workflow.db への副作用が検証側から除去されたことで、並列実行やリトライ時の再現性が向上する。
