---
name: mt-sdd
description: Spec-Driven Development（仕様駆動開発）を全フェーズ一括で実行する。要求分析から仕様策定・レビュー・実装計画・実装・検証まで、SubAgent への役割委譲で開発を進める。SDD、仕様駆動、spec-driven と言われた時に使用する。
---

# Spec-Driven Development (SDD) — オーケストレーター

機能レベルの仕様を起点に、SubAgent への役割委譲で開発を進めるワークフロー。
各フェーズは独立した Skill として実行可能。このオーケストレーターは全フェーズを一括で実行する。

## 🧠 前提知識

- セッション管理: [session.md](session.md) を参照
- SubAgent 実行プロトコル: [subagent-protocol.md](subagent-protocol.md) を参照
- UCR（上流変更要求）処理: [upstream-change-protocol.md](upstream-change-protocol.md) を参照
- 関連 Skill: mt-sdd-spec（仕様策定）, mt-sdd-implement（実装）, mt-sdd-validate（検証）

## 🏃 ステップ

### 1. セッション初期化

[session.md](session.md) を Read し、セッションディレクトリを作成する。

### 2. 仕様策定 + レビュー

[../mt-sdd-spec/SKILL.md](../mt-sdd-spec/SKILL.md) を Read して実行する。

- コンテキスト収集 → 要求ヒアリング → 仕様書作成 → 4 観点レビュー → 自動修正ループ → Process Auditor → Human Gate

### 3. 実装計画 + レビュー + 実装 + コードレビュー

[../mt-sdd-implement/SKILL.md](../mt-sdd-implement/SKILL.md) を Read して実行する。

- 実装計画作成 → 4 観点レビュー → 自動修正ループ → Process Auditor → Human Gate 2 → レイヤー順序でタスクを並列/直列実行 → コードレビュー → 自動修正ループ → Human Gate 3

### 4. 仕様適合検証

[../mt-sdd-validate/SKILL.md](../mt-sdd-validate/SKILL.md) を Read して実行する。

- 受け入れ基準の適合検証 → 検証レポート生成

## ✅ 完了条件

- 仕様書（`spec.md`）が確定している
- 実装計画（`implementation-plan.md`）が確定している
- 実装が完了し、コードレビューを通過している
- 仕様適合検証レポートが生成されている

## 📦 アウトプット

セッションディレクトリに以下のファイルが生成される：

- `spec.md`（仕様書）
- `appendix-hearing-log.md`（ヒアリング記録）
- `appendix-spec-review.md`（仕様レビューレポート）
- `implementation-plan.md`（実装計画書）
- `appendix-plan-review.md`（計画レビューレポート）
- `appendix-code-review.md`（コードレビューレポート）
- `appendix-validation-report.md`（検証レポート）

## ⚠️ 注意事項

[common-guidelines.md](common-guidelines.md) を参照。
