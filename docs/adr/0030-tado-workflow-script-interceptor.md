---
status: proposed
---

# tadoワークフロー スクリプト実行のワークフロー側移行（interceptor）

## Context

tadoワークフロー（`mt-plan-run` 等）は `buildPrompt` でエージェントにスクリプト実行を指示している。エージェントの不確実性により手順抜かし・捏造が発生し、決定論性と監査可能性が損なわれる。

2026-09-17のM1では、plan-runの収集専用 `collect_context` を削除し、直後にあった `run_reviewers`（検証者起動）の `beforeStep` へ収集・機械検証を移した。hookだけ追加して専用ステップを残す案では往復削減が0だったため、ステップ境界を変更した。以下は承認済み計画の転記ではなく、M1の実装・実エンジン検証を踏まえたM2の記録である。PoC方針は承認済みだが、横展開・基盤化は未承認のためADRは `proposed` を維持する。

ここでの「interceptor」はプロンプトの文字列を横取りする機構ではなく、既存hookによる明示的な収集・機械検証の移設を指す。「読み取り専用」は収集元のGitに対する性質であり、セッション成果物・DBへの書き込みは行う。敵対的検証の判断は引き続きエージェントが担う。

今回の収集対象は `diff.txt` / `effort.json`（補助 `context.md`）。`gh issue view` は別ステップ、`db.ts` / `audit.ts` のread系は当該ステップの収集対象外である。旧収集キーを引き継ぐ計画にはしない。`parallel` の型上の制約は外部 `ParallelStepDef` / `ParallelConfig.subtasks` / `SubtaskConfig` を参照する（旧ADR-002は不存在）。

## Decision

- ユーザー承認済みのPoCとして、plan-run側の収集専用 `collect_context` ステップを削除し、直後の `run_reviewers.beforeStep` へ収集スクリプトと既存相当の検証を移す。収集専用AIプロンプトとreportを撤去して、収集・検証者起動を通過する各サイクルで1往復削減する。`run_reviewers` のレビュー判断・検証者起動・本来のreportは残す
- Git差分収集、Issue body由来のeffort補完、補助context生成を `Bun.$` / `node:child_process` 等の既存手段と `_shared/` ヘルパで決定論的に行う。`diff.txt` / `effort.json` を `ArtifactInput[]` としてDB登録し、補助 `context.md` を生成する。後続の `PromptCtx.artifacts` / `CheckCtx.artifacts` から参照でき、反復時も現行キーで更新する。旧キーへの後方互換レイヤーは追加しない
- 収集後・レビュー用プロンプト生成前に、現行相当の差分範囲・完全性検証（truncate、target有無に応じたuntracked/staged、numstat突合）とeffort契約検証を実施する。失敗はhook失敗として扱う。既存相当の検証を維持するためのplan-run側check変更は許可するが、旧収集専用reportを偽造して残さない
- 収集または検証の失敗時は、外部tadoの既存仕様により初回実行 + `run_reviewers` の `maxRetries` 回再試行し、全失敗なら step を `failed`、セッションを `aborted` とする。レビュー用および後続のプロンプトは生成せず、エージェントへフォールバックしない。原因解消後は新規セッションで再実行する。`onFail.action` の `escalate` 適用は要求しない
- 実装範囲はplan-runの必要なステップ構成・`buildPrompt`・`check`・import/コメント、`_shared/` ヘルパ、plan-runの `workflow.test.ts` / `__snapshots__/` とする。外部tadoとreview-diff本体は改修しない。plan-run側で不要になった収集コードパスは撤去するが、孤児ファイル `mt-plan-collect-review-context.ts` は再利用可否の先行判定・削除予定の記録のみとし、今回編集・削除しない
- hookのPoCは単一の `task: orchestrate`（`run_reviewers`）に限定し、エンジンの `parallel` ステップ・subtaskへの適用は対象外とする。既存の検証者並列起動は維持する。権限は現行エージェントと同一（ローカルBun）で、分離機構は追加しない
- ADR-0019のStep importによる敵対的検証の再利用を維持する。ただし「収集Stepも取り込む」構成はplan-runに限って更新し、判断用の `task` / `check` は同一Stepを継承する。ADR-0014の作成/実行の責務分離、ADR-0002のデプロイ先を直接編集しない原則を維持する。新ヘルパは `_shared/` 配置でもplan-run専用であり、汎用interceptor APIの採用を意味しない。ADR-0028の型設定の所有方針も変更しない（現環境との不整合は下記）。

## PoCの学習と根拠（2026-09-17）

根拠となる実装は `chezmoi/dot_tado/workflows/` 以下の `mt-plan-run/index.ts`、`_shared/collect-plan-review-context.ts`、`mt-plan-run/workflow.test.ts`。実行証跡はセッション `/Users/mt/.tado/sessions/20260917-200611-szm3/` の `m1-result.json`、`m1-log.md`、`m1-final-tests.log`（7/10行: 往復、12/14行: 失敗、526–528行: 集計）にある。

| 確認した成果 | 学習・適用上の意味 |
| --- | --- |
| 同条件2サイクルの収集・検証者起動区間で旧4往復 → 新2往復。`run_reviewers` のprompt/report/checkを維持してjudgeへ進行 | 1往復は完了する `next` → `report` の組。削減はサイクル毎1往復で、hook単体の性能改善ではない。judge等の区間外や待機中の再`next`はこの集計に含まない |
| `diff.txt` / `effort.json` を `PromptCtx.artifacts` / `CheckCtx.artifacts` と実DBで参照し、2サイクル後も同名2キー。diffは `+round2` に更新 | 反復では現行キーを再登録・上書きできる。effortは既存値を検証して再保存する（測定中の値はwidth=low/depth=max/round=1のまま）。上書きは毎回の再推論やround加算を意味しない |
| 不在baseによる収集失敗とnumstat不一致による検証失敗の双方で、初回+maxRetries(3)の計4回失敗 → step=`failed` / session=`aborted`。prompt生成0、step_attempts=0、次の`next`も拒否 | hook失敗はAIのcheck再試行やescalateとは別の停止境界。不完全な収集物をAIに直させず、原因解消後は新規セッションで実行する |
| truncate、target有無に応じたuntracked/staged、numstat、effort契約を既存ヘルパで検証。実Gitでindex不変。target指定・空差分も検証 | 機械検証をprompt前へ移し、旧収集reportの偽造は不要。`--no-index` の終了値1だけを差分ありとして扱い、その他の収集失敗は伝播する |
| 関連8テストファイルは499 pass / 0 fail、32 snapshots、2208 assertions | 実tado CLI・Git・DBを使った隔離ハーネスの結果。旧AI収集は同じ収集関数でfixture化し、検証者の出力もfixtureであり、実Issueでのplan-run全体やAI判断品質の実測ではない |

旧孤児 `mt-plan-run/mt-plan-collect-review-context.ts` はそのまま再利用できない。`markUntrackedIntentToAdd` はindexを変更し（94–102行）、差分取得失敗を空文字に縮退し（74–91行）、出力は旧 `git-branch-diff.txt` / `git-unstaged-diff.txt` / `issue-body.md` で現契約に一致しない（140–148行）。失敗停止・読み取り専用の契約に反するため、再利用ではなく削除予定候補として記録する。今回の編集・削除対象には含めない。

### 追記: 16MiB超差分の修正後（2026-09-18）

上記499 passは初回PoCの記録として保持する。後続の修正証跡は旧セッション `20260917-200611-szm3/large-diff-fix-log.md`、再開後の確認は `/Users/mt/.tado/sessions/20260918-000942-itu3/` の `m1-result.json` / `m1-tests.log` を参照する。

- 追跡済み差分17,843,631 bytes・単一未追跡差分17,843,365 bytesで、修正前は双方 `ENOBUFS`、修正後は実Git出力との全文一致・末尾・index不変・一時ファイル非残存を確認。全Git差分（target指定を含む）はサイズに関係なく一時ファイルへstdoutを直接出力する。バッファ増量やサイズ別フォールバックではなく、共通の収集経路でstdoutの16MiB制限を除いた。
- 完全性検証は引き続き `readFileSync` で全文をメモリへ読む。任意サイズの低メモリ処理や、補助コマンドを含む全バッファ制限の解消は保証しない。FDを閉じ、一時ディレクトリをfinallyで削除する。部分出力後の `--no-index` exit 2と完全性検証失敗では、既存の正式成果物3ファイルを保持して後始末することを確認した。
- 修正後の関連8ファイルは **503 pass / 0 fail、32 snapshots、2230 assertions**（旧セッション）。新セッションM1のplan-run単体再検証は **167 pass / 0 fail、32 snapshots、1020 assertions**。2サイクル4→2往復、現行キーの登録・上書き、4回失敗後のfailed/abortedも維持。M2はこれらの証跡を照合し、テストは再実行していない。既存型設定問題と未承認事項は解消・承認されたものとして扱わない。

## 制約と帰結

- 対象は単一 `task: orchestrate`。外部tadoの `src/types/workflow-def.ts` では `ParallelStepDef` は `ExecutableStepDefBase` のhookを継承するが、`SubtaskConfig` にhookはない。「parallel全体にhookがない」とは解釈しない。本PoCはどちらの実行挙動も保証せず、検証者の並列起動とエンジンのparallelは区別する。
- 冪等性は同じ収集元から同じ現行キーを更新できる性質であり、Gitの同時変更を固定するスナップショット分離やファイル/DBの一括トランザクションではない。一時ファイルで全収集検証・補助context生成・effort保存を済ませ、正式成果物を順次renameし、hook成功時にDB登録する構成である。rename途中の失敗まで含めた3ファイル一括置換は保証しない。失敗時にAIへフォールバックしないことと、権限が制限されていることは別であり、今回はローカルBunの既存権限のまま。
- 型検査は未解決の既存環境問題を残す。`chezmoi/dot_tado/tsconfig.json` の `extends: tado/tsconfig.base` が解決できず、`m1-typecheck.log:1` はTS6053。インストール版 `node_modules/tado/package.json` のexportsにも当該項目がない。ADR-0028の提供予定とインストール版の不整合で、PoCが解消したものではない。M1は変更3ファイルを明示フラグ付きstrict tscで個別検査しエラー0と報告しているが、プロジェクト型検査の成功とは扱わない。外部tadoや設定を本計画で修正しない。
- 既存hookによる実装を完結した最小構成とする。横展開のためだけの互換レイヤー・AI代行経路・新しいステップ型は作らない。外部依存の更新時は型の有無だけでなく、artifact上書き・失敗停止・往復数の実行契約を再確認する。

## 横展開・基盤化の推奨案（未承認、別計画で判断）

| 論点 | 推奨案と判断材料 |
| --- | --- |
| 横展開順 | まず `mt-deep-research` のread系を候補調査する。既存 `afterInit` の決定論実行が前例であり、収集とAI判断の境界を比較しやすい。次に `mt-plan-create` / `mt-propose-*` のread系を評価し、`gh label`・`mt hunk`・DB保存等の書き込み系は後段の別評価とする。収集専用往復が実際に消せるか、失敗再実行が安全かを確認するまで対象・順序を確定しない |
| 正式API / `StepCtx` | 現状の `beforeStep(StepCtx) → Promise<ArtifactInput[]>` と用途別ヘルパを当面の比較基準にする。別ワークフローで不足が実証された場合に限り、hook拡張・専用interceptorフィールド・`run_command`実実行化を比較する。正式APIの採用や外部tado改修は未承認 |
| parallel / 権限分離 | 今回は追加しない。必要性を別計画で確認し、同名artifactの競合、失敗の単位（全体/subtask）、再試行時の副作用を具体例で検証してからparallelの適用単位を決める。権限分離は同一Bunでの決定論化と独立した要件として、収集元read・成果物write・ネットワーク/認証の必要範囲を評価する |

## 最終Human Gateで判断が必要な事項

- PoCの証跡範囲（隔離ハーネスでの区間測定、全ワークフロー実行・AI判断品質は未実測）を受け入れるか、実Issueによる追加確認を求めるか。
- 横展開対象の優先順位、正式API / `StepCtx` 拡張、parallel / 権限分離を未承認として別計画へ委ねる整理への合意。上記推奨は着手許可や採用決定ではない。
- 旧孤児の削除予定と既存型設定問題を別途扱うか、その優先度。今回のスコープを無断で拡大しない。

本ADRの学習反映と、上記判断へのユーザー合意は別である。M2文書作成だけをもってPoC全体のDoneや基盤化の承認とはしない。
