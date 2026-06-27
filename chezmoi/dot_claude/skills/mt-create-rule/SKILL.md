---
name: mt-create-rule
description: 棲み分けガイドラインと個人テンプレートに基づいて対話的にRule定義ファイルを作成する。ガイドライン判断フロー・SubAgent委譲・レビュー改善ループを含む。「Rule作成」「ルール追加」「mt-create-rule」と言われた時に使用する。
---

# Rule 作成

棲み分けガイドラインと個人テンプレートに基づいて、対話的に Rule 定義ファイルを作成する。

## 🧠 前提知識

- 棲み分けガイドライン: `_shared/cursor-config-guideline.md`
- Rule テンプレート: `_cursor_user/skills/mt-create-rule/rule-template.mdc`
- レビュー Skill: `_cursor_user/skills/mt-review-cursor-config/SKILL.md`
- 共通フロー: `_cursor_user/skills/_shared/create-my-config-workflow.md`

## 🏃 ステップ

### 1. 要求・要件分析

共通フローの「要求・要件分析」に従い、Rule 固有の観点として以下を把握する:

- **何を実現したいか**: どんな制約・規約をエージェントに適用したいか
- **なぜ必要か**: この Rule がないと何が困るか
- **どんな場面で使うか**: 特定のファイルを扱うときか、常時か

### 2. ガイドライン判断

棲み分けガイドラインの簡易チェックリストで、Rule が適切な種類か確認する:

1. イベント駆動の自動処理か？　→ **Yes: Hook が適切**（この Skill では対象外。案内のみ）
2. 全セッション・全タスクで、魂として常に持つべき思想・考え方・コミュニケーションスタイルか？　→ **Yes: Rule が適切** ✅
3. 機械的な検証・修正・権限管理で扱える具体制約か？　→ **Yes: Linter / Formatter / Hook / 権限管理が適切**（この Skill では対象外。案内のみ）
4. サブエージェントの Who 定義か？　→ **Yes: SubAgent が適切**（`mt-create-subagent` を案内）
5. 上記いずれでもない → **Skill が適切**（`mt-create-skill` を案内）

> 詳細な判断フローは `cursor-config-guideline.md` の簡易チェックリストを参照。

Rule が適切でないと判断した場合、理由とともに別の種類を提案し、ユーザーに確認する。

### 3. フィールド収集

本文での選択肢提示と対話で Rule 固有のフィールドを収集する:

|フィールド|収集方法|
|---|---|
|**Rule 名**|ファイル名（kebab-case `.mdc`）を提案し確認|
|**description**|Rule の目的を 1 文で（frontmatter 用）|
|**alwaysApply**|選択肢: `true`（常時適用）/ `false`（条件付き）|
|**globs**|alwaysApply が false の場合のみ。対象ファイルパターンを確認。true の場合は空文字列|
|**本文**|Rule の内容（制約・規約）を対話で整理|

本文の整理時は以下を確認する:

- `core-rules.md` に入れる内容は「エージェントの魂」と呼べる普遍的な思想・対話姿勢に限定されているか
- 条件付き Rule に入れる内容は、対象 glob で常時効く必要がある最小制約・発動条件に限定されているか
- 具体的な操作手順・検証条件・権限・フォーマット制約が混入していないか（Skill / SubAgent / Hook / Linter / Formatter / 権限管理へ委譲する）
- 簡潔か（Rule はロードされるだけでコンテキストを消費する）
- **Rule は薄く、具体は Skill へ**: 具体的な手順・フォーマット・チェックリストは Skill に移譲し、Rule 本文は「発動条件 + Skill パス」のスタブに留める。Skill パスを明示することで空振りを防ぐ
- **alwaysApply の場合**: ユーザーレベルでは `~/.cursor/rules/` 配下の `alwaysApply: true` は Cursor 仕様上機能しない。常時適用が必要な内容は `_cursor_user/settings-source/core-rules.md` に追記し、Cursor Settings → User Rules へ手動コピペで反映する。ただし `core-rules.md` に置くのは普遍的な思想・対話姿勢だけとし、具体制約は置かない。個別の `.mdc` Rule は description / globs モードのみで運用する

### 4. 配置先確認

共通フローの「配置先確認」に従って、本文で配置先の選択肢を番号付きで提示して確認する:

- **プロジェクトレベル**（`_cursor/rules/`）: 特定プロジェクト固有の制約
- **ユーザーレベル**（`_cursor_user/rules/`）: 全プロジェクト共通の制約

### 5. Creator SubAgent に作成を委譲

`mt-cursor-config-creator` SubAgent を Task ツールで呼び出し、ファイル生成を委譲する。

prompt に以下を含める:

```text
mode: create
type: rule
template_path: [テンプレートの絶対パス]
output_path: [配置先の絶対パス]
fields: {
  "name": "[Rule名]",
  "description": "[description]",
  "alwaysApply": [true/false],
  "globs": "[globsパターン]",
  "body": "[本文の内容]"
}

作成手順:
1. template_path のテンプレートを Read で読み込む
2. テンプレートのコメント（<!-- ... -->）を削除し、fields の値で frontmatter と本文を構成する
3. output_path に Write で出力する
4. 作成したファイルのパスと内容のサマリを返す
```

### 6. レビュー・改善ループ

共通フローの「レビュー・改善ループ」に従って、`mt-review-cursor-config` Skill と `mt-cursor-config-creator` SubAgent を使い品質を確保する。

### 7. 🟢 Nice to Have の確認

共通フローの「Nice to Have の確認」に従い、対応要否をユーザーに確認する。

### 8. 同期案内

共通フローの「同期案内」に従い、Rule の配置先に応じた同期コマンドを案内する。

## ✅ 完了条件

- Rule 定義ファイルが適切な配置先に作成されている
- Reviewer SubAgent のレビューで 🔴 Must Fix / 🟡 Should Fix がゼロ
- ユーザーが最終的な内容を確認・承認している

## ⚠️ 注意事項

- Rule に手順・ワークフローが混入しないよう注意する。特に `core-rules.md` は普遍的な思想・対話姿勢のみ
- 具体的な制約は、まず Linter / Formatter / Hook / 権限管理 / Skill / SubAgent / 人間レビューで扱えないか検討する
- Rule はロードされるだけでコンテキストを消費するため、簡潔さを重視する
- フィールド収集で不足情報がある場合は、ユーザーへ確認してから Creator SubAgent に渡す
