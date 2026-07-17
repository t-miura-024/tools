---
status: accepted
---

# mattpocock/skills の既存運用への適応方針

Issue #28 に基づき、固定した `mattpocock/skills@66898f60e8c744e269f8ce06c2b2b99ce7660d5f` の現行 Skill を評価した。独立した責務を持つものは新規 Skill とし、既存の責務に収まるものは canonical source の既存定義へ統合し、上流固有・環境固定・非現行・ユーザー不要のものは採用しない。原文を複製・機械翻訳せず、日本語と既存の責務分離へ適応する。派生設定は直接編集せず、`mt agent sync` と `mt chezmoi apply` は本計画では実行しない。

## 出典・適用条件

- Issue: [#28 mattpocock/skills を既存運用へ適応・統合する](https://github.com/t-miura-024/tools/issues/28)
- 対象リビジョン: [`mattpocock/skills@66898f60e8c744e269f8ce06c2b2b99ce7660d5f`](https://github.com/mattpocock/skills/tree/66898f60e8c744e269f8ce06c2b2b99ce7660d5f)
- 原典ライセンス: [MIT License](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/LICENSE)（Copyright (c) 2026 Matt Pocock）
- 評価日: 2026-07-15
- 承認反映日: 2026-07-16
- canonical source: `chezmoi/dot_cursor/`

## ユーザー承認で確定した変更

- `grill-with-docs` は新規 Skill とし、`mt-create-plan` にも統合する
- `codebase-design` は `mt-sdd-architecture-reviewer` に加え `mt-review-diff` へも統合する
- `implement` は `mt-sdd-implement` に加え `mt-run-plan` へも統合する
- `improve-codebase-architecture` は既存レビューへ統合し、単独 Skill としても新規作成する
- `triage`・`teach`・`prototype` は不要として見送る
- 本一覧は `grill-with-docs` が残す文書形式（domain-modeling の ADR）に従う

## 現行 Skill の分類

| 出典 | 判断 | 統合先または新規名 | 採用・見送り理由 |
| --- | --- | --- | --- |
| [`ask-matt`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/ask-matt/SKILL.md) | 見送り | - | 上流固有の Skill 名とフローを案内するルーターであり、現行カタログと整合しない。 |
| [`code-review`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/code-review/SKILL.md) | 統合 | `mt-review-diff` | 既存の差分レビューと同責務。仕様適合と設計上の臭いの観点を補う。 |
| [`codebase-design`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/codebase-design/SKILL.md) | 統合 | `mt-sdd-architecture-reviewer` / `mt-review-diff` | 深いモジュールと seam の設計語彙をアーキテクチャレビューと差分レビューへ加える。 |
| [`diagnosing-bugs`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/diagnosing-bugs/SKILL.md) | 統合 | `mt-analyze-error` | 原因・影響・対策の既存責務に、高速で失敗する再現の確立を加える。 |
| [`domain-modeling`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/domain-modeling/SKILL.md) | 統合 | `mt-sdd-spec` / `mt-grill-with-docs` | 用語と ADR の確定は仕様策定と文書付きヒアリングの一部とする。 |
| [`grill-with-docs`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/grill-with-docs/SKILL.md) | 新規+統合 | `mt-grill-with-docs` / `mt-create-plan` | 文書を残す徹底ヒアリングは独立責務。計画作成の Grill Phase にも取り込む。 |
| [`implement`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/implement/SKILL.md) | 統合 | `mt-sdd-implement` / `mt-run-plan` | 実装・検証・最終レビューの原則を SDD 実装と計画実行の両方へ補う。 |
| [`improve-codebase-architecture`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/improve-codebase-architecture/SKILL.md) | 新規+統合 | `mt-improve-codebase-architecture` / `mt-sdd-architecture-reviewer` / `mt-review-diff` | 改善候補の探索は単独 Skill とし、既存レビューにも候補発見観点を加える。 |
| [`prototype`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/prototype/SKILL.md) | 見送り | - | ユーザー判断により不要。 |
| [`research`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/research/SKILL.md) | 統合 | `mt-deep-research` | 調査・引用・レポートは既存責務。軽量な一次資料調査の入口を補う。 |
| [`resolving-merge-conflicts`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/resolving-merge-conflicts/SKILL.md) | 新規 | `mt-resolve-merge-conflicts` | 競合を意図を保って解消する専用手順は存在しない。 |
| [`setup-matt-pocock-skills`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/setup-matt-pocock-skills/SKILL.md) | 見送り | - | 上流固有の issue tracker・文書構造を前提とし、既存の計画管理と二重化する。 |
| [`tdd`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/tdd/SKILL.md) | 統合 | `mt-sdd-implement` | テスト seam の合意と Red-Green の原則を既存実装工程に統合する。 |
| [`to-spec`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/to-spec/SKILL.md) | 統合 | `mt-sdd-spec` | 会話から仕様を合成する経路は既存仕様策定と重複する。 |
| [`to-tickets`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/to-tickets/SKILL.md) | 統合 | `mt-create-plan` | 依存関係を明示した縦切り分解を計画作成の方針へ加える。 |
| [`triage`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/triage/SKILL.md) | 見送り | - | ユーザー判断により不要。 |
| [`wayfinder`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/wayfinder/SKILL.md) | 新規 | `mt-wayfinder` | 大きく不確実な企画の決定マップ作成は、実行計画とは異なる責務である。 |
| [`grill-me`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/productivity/grill-me/SKILL.md) | 統合 | `mt-grill-me` | 既存 Skill と同責務。確認が済むまで実行しない原則を補う。 |
| [`grilling`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/productivity/grilling/SKILL.md) | 統合 | `mt-grill-me` | 一問ずつの選択肢提示は既に実装済みで、探索で答えられることは質問しない規則を補う。 |
| [`handoff`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/productivity/handoff/SKILL.md) | 新規 | `mt-handoff` | セッションの会話文脈を次回へ渡す手順は、`mt-workflow` の状態管理と別責務である。 |
| [`teach`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/productivity/teach/SKILL.md) | 見送り | - | ユーザー判断により不要。 |
| [`writing-great-skills`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/productivity/writing-great-skills/SKILL.md) | 統合 | `mt-create-skill` | progressive disclosure と no-op 評価を Skill 作成規約に取り込む。 |
| [`git-guardrails-claude-code`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/misc/git-guardrails-claude-code/SKILL.md) | 見送り | - | Claude Code 専用 hook であり、既存の canonical 設定管理と競合する。 |
| [`migrate-to-shoehorn`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/misc/migrate-to-shoehorn/SKILL.md) | 見送り | - | 特定 TypeScript 依存への一回限りの移行手順である。 |
| [`scaffold-exercises`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/misc/scaffold-exercises/SKILL.md) | 見送り | - | 上流作者の演習リポジトリ構造とコマンドに固定されている。 |
| [`setup-pre-commit`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/misc/setup-pre-commit/SKILL.md) | 見送り | - | Husky・lint-staged の導入を固定し、各リポジトリの既存規約を壊し得る。 |
| [`edit-article`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/personal/edit-article/SKILL.md) | 新規 | `mt-edit-article` | 既存原稿の構造・明瞭性・簡潔さを改善する専用の責務がある。 |
| [`obsidian-vault`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/personal/obsidian-vault/SKILL.md) | 見送り | - | 上流作者固有の vault パスと命名規則を前提とする。 |

## 非現行 Skill

`deprecated` と `in-progress` は成熟度または責務境界が十分でないため実装対象外とする。

| 出典 | 状態 | 判断 | 見送り理由 |
| --- | --- | --- | --- |
| [`design-an-interface`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/deprecated/design-an-interface/SKILL.md) | deprecated | 見送り | 後継の `codebase-design` を評価済み。 |
| [`qa`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/deprecated/qa/SKILL.md) | deprecated | 見送り | 後継の `triage` を評価済み。 |
| [`request-refactor-plan`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/deprecated/request-refactor-plan/SKILL.md) | deprecated | 見送り | 後継の `to-spec`・`to-tickets` と既存の計画作成に分散済み。 |
| [`ubiquitous-language`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/deprecated/ubiquitous-language/SKILL.md) | deprecated | 見送り | 後継の `domain-modeling` を評価済み。 |
| [`claude-handoff`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/claude-handoff/SKILL.md) | in-progress | 見送り | Claude CLI 固有かつ未成熟。 |
| [`loop-me`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/loop-me/SKILL.md) | in-progress | 見送り | 上流の個人ワークスペース構造を前提とする。 |
| [`setup-ts-deep-modules`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/setup-ts-deep-modules/SKILL.md) | in-progress | 見送り | 未成熟な TypeScript 構造の強制導入である。 |
| [`wizard`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/wizard/SKILL.md) | in-progress | 見送り | 秘密情報・GitHub Secrets を扱う未成熟なテンプレートである。 |
| [`writing-beats`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/writing-beats/SKILL.md) | in-progress | 見送り | 執筆フローの責務境界が未確定である。 |
| [`writing-fragments`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/writing-fragments/SKILL.md) | in-progress | 見送り | 執筆フローの責務境界が未確定である。 |
| [`writing-shape`](https://github.com/mattpocock/skills/blob/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/in-progress/writing-shape/SKILL.md) | in-progress | 見送り | 執筆フローの責務境界が未確定である。 |

## 集計

| 判断 | 件数 |
| --- | ---: |
| 新規 | 5 |
| 新規+統合 | 2 |
| 統合のみ | 11 |
| 見送り（現行） | 10 |
| 見送り（非現行） | 11 |

## Consequences

- 変更先は `chezmoi/dot_cursor/` のみとする
- 本 ADR が Issue #28 の分類一覧の Source of Truth となる
- 旧ファイル `chezmoi/dot_cursor/skills/_shared/mattpocock-skills-assessment.md` は本 ADR に置き換える
