---
status: accepted
---

# hunkセッション強制とcheck硬直化

## Context

`mt-plan` のレビューサイクル (`review_work` → `start_hunk_review` → `await_review` → `check_hunk`) は、hunk daemonの外部真実を `check` で検証していなかった。`start_hunk_review` の `check` は `attemptResult.status === 'completed'` だけでpassし、`await_review` の `check` は常にpass、`check_hunk` の `check` はJSONパースだけでdaemon再取得をしなかった。そのためAIが `hunk-start.json` を `session:null` で偽装したり、`await_review` を人間確認なしに `approve` でreportしたり、`check_hunk` を `{"passes":true}` で自作して迂回でき、Plan #87 で再現した。`confirm_diff_with_wants` のような新Gate追加は `should` 未対応時の冗長Gateになるため不採用。

## Decision

- `execute_work` と `review_work` の間に `ensure_hunk_session` (type: human_gate, maxRetries: 3) を新設する。プロンプトで `BASE_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')` と `hunk diff <base>` 手順を提示し、`check` で `hunk session get --repo <root> --json` の成功により TUI 生存を検証する。失敗なら `fail` でリトライ。choices は tado エンジンが処理する approve / revise / abort の value のみを使い、ready 相当の選択は value: approve（label: 「hunk TUI を起動した（ready）」）として label 側に注記する。
- `start_hunk_review` の `check` で `hunk-start.json` の `session != null` かつ `mt hunk status == active` を検証する。
- `await_review` の `check` で `mt hunk status == active` を再検証する。
- `check_hunk` の `check` で `mt hunk check` をdaemonから再取得し、artifactのJSONと一致することを検証する。不一致なら `fail`。
- `want` の運用は維持する。hunk上に表示するが `passes:true` のままブロックせず、人間コメントが同一行に付いたwantのみ次回 `execute_work` で修正対象とする。追加の成果物提示は行わずhunk TUIで確認する。

## Consequences

- hunkセッション不在でのレビュー迂回が機械的に検出され、偽装reportは `fail` になる。
- `want` のみの場合でも `await_review` の人間承認が必須のまま残るため、差分レビューの文脈はhunk上で担保される。
- `ensure_hunk_session` の活性検出は `hunk session get` の成否に依存する。`mt hunk status` は `.hunk/hunk-review.json`（`mt hunk start` 後に作成）が無いと TUI が生きていても常に `none` を返すため、start 前のこのゲートでは使えない。一方 `start_hunk_review` / `await_review` の `check` は引き続き `mt hunk status` の文言に依存するため、hunk CLIの出力変更時は該当 `check` の更新が必要。
