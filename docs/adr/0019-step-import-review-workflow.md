---
status: accepted
---

# Step import による敵対的検証機構一本化

## 背景 (Context)

敵対的検証に関わる検証観点プール・SubAgent 割当・hunk 変換ロジックが `mt-review-diff` Skill、`mt-plan-run` 内の hunk サイクル、SubAgent 定義に分散していた。検証観点の重複、taxonomy 揺れ、検証強度制御手段の不在が課題であった。`tado init` にパラメータ機構がなく検証呼び出しがばらけ、`mt-sdd-*` 等は孤児化していた。grill Round 3-6 で SoT 一本化の方針を集中的に議論し、tracer bullet で契約を先に固める原則が合意された。

旧構成では `mt-plan-run` が独自に hunk コメント生成・findings 集約を行い、`mt-review-diff` Skill が別実装で重複していた。両者を二重管理すると修正時の乖離が必発であり、単独起動と計画内検証の二入口を単一実装で成立させる必要があった。

## 決定 (Decision)

検証観点プール・SubAgent 割当・hunk 変換ロジックを tado ワークフロー `mt-review-diff`（敵対的検証ワークフロー）に単一 SoT として集約し、`mt-plan-run` から Step を import する方式とした。`_shared` への退避ではなくワークフロー定義が SoT になることで、二入口が単一実装で成立し二重管理を防ぐ。

具体的には `resolve_effort` / `collect_context` / `run_reviewers` / `publish_findings` / `await_human_review` / `collect_verdict` の 6 Steps を `mt-review-diff` で定義し、`mt-plan-run` は Step import で取り込み、必要最小限の check オーバーライドのみ行う。`_shared` への純粋関数抽出は次回計画に先送りし、今回は Step import を維持する。

grill で合意した制約: 検証 Step は hunk と findings/verdict アーティファクトにのみ副作用を持ち、workflow.db のループ制御に触れない。

## 代替案 (Considered Options)

- `_shared` へ純粋関数を抽出し両ワークフローから共有する方式: 関心事の分離は綺麗だが、Step 単位の再利用ができずプロンプト・check・task の整合性を手動で保つ必要がある。tracer bullet 段階では過剰な抽象化であり、grill で「ワークフロー定義が SoT」の方が二入口の一致を機械的に担保できると判断し不採用。
- Skill とワークフローの併存・コピー維持: 後方互換は保てるが、呼び出し元の新経路統一ができず孤児資材の温存になる。完了条件 4 に反するため不採用。
- ワークフロー間の兄弟直接 import を禁止し完全分離: 理想だが現状 tado に共有ライブラリ機構がなく、Step import 以外の再利用手段がない。暫定的に兄弟 import を許容し、次回 `_shared` 抽出で解消する方針とした。

## 帰結 (Consequences)

- 単独起動（`@tado-run mt-review-diff`）と計画内検証（`mt-plan-run` の review_work 置換）が単一実装で成立し、二重管理が解消される。
- `mt-plan-run` は `mt-review-diff` に依存するため、後者の Step インターフェース変更時は前者の追従が必要。一時的な密結合を許容する。
- `_shared` への抽出は次回計画の TODO とし、対象は `findArtifactText` 等の I/O ヘルパ、`parseEffort` 系パーサ、正規表現統一等。小規模な純粋関数のみを段階的に移行する。
- 旧資材（`mt-review-diff` Skill、`mt-plan-work-reviewer`、`mt-sdd-*` 等）は `chezmoi/.chezmoiremove.tmpl` で削除対象となり、孤児化が解消される。
