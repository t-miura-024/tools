---
name: mt-create-skill
description: 棲み分けガイドラインと個人テンプレートに基づいて対話的にSkill定義ファイルを作成する。ガイドライン判断フロー・SubAgent委譲・レビュー改善ループを含む。「Skill作成」「スキル追加」「mt-create-skill」と言われた時に使用する。
---

# Skill 作成

棲み分けガイドラインと個人テンプレートに基づいて、対話的に Skill 定義ファイルを作成する。

## 🧠 前提知識

- 棲み分けガイドライン: `_shared/cursor-config-guideline.md`
- Skill テンプレート: `_cursor_user/skills/mt-create-skill/skill-template.md`
- レビュー Skill: `_cursor_user/skills/mt-review-cursor-config/SKILL.md`
- 共通フロー: `_cursor_user/skills/_shared/create-my-config-workflow.md`

## 🏃 ステップ

### 1. 要求・要件分析

共通フローの「要求・要件分析」に従い、Skill 固有の観点として以下を把握する:

- **何を実現したいか**: どんなタスク・ワークフローを自動化・支援したいか
- **なぜ必要か**: 手動でやると何が大変か、どんな頻度で発生するか
- **どんな場面で使うか**: どんなキーワード・状況でトリガーされるべきか

### 2. ガイドライン判断

棲み分けガイドラインの簡易チェックリストで、Skill が適切な種類か確認する:

1. イベント駆動の自動処理か？　→ **Yes: Hook が適切**（この Skill では対象外。案内のみ）
2. 全セッション・全タスクで、無視されたら困る制約か？　→ **Yes: Rule が適切**（`mt-create-rule` を案内）
3. サブエージェントの Who 定義か？　→ **Yes: SubAgent が適切**（`mt-create-subagent` を案内）
4. 上記いずれでもない → **Skill が適切** ✅

> 詳細な判断フローは `cursor-config-guideline.md` の簡易チェックリストを参照。

Skill が適切でないと判断した場合、理由とともに別の種類を提案し、ユーザーに確認する。

### 3. フィールド収集

本文での選択肢提示と対話で Skill 固有のフィールドを収集する:

| フィールド           | 収集方法                                               |
| --------------- | -------------------------------------------------- |
| **name**        | Skill 名（kebab-case）を提案し確認                          |
| **description** | Skill の目的・用途を 1 文で（frontmatter 用。WHAT と WHEN を含める） |
| **前提知識**        | 参照すべきファイル・外部リソースがあるか確認。不要なら省略                      |
| **ステップ**        | 対話でワークフローを整理し、ステップバイステップに構成する                      |
| **完了条件**        | Skill の完了を判定する基準を列挙                                |
| **アウトプット**      | 成果物がある場合はその定義。不要なら省略                               |
| **注意事項**        | 制約・例外・落とし穴を確認                                      |

ステップの整理時は以下を確認する:

- サブエージェントのペルソナ・行動原則が混入していないか（→ SubAgent へ）
- 全セッション適用の制約が混入していないか（→ Rule へ）
- SKILL.md が 500 行以内に収まる粒度か（超える場合は参照ファイルに分離を提案）

### 4. 配置先確認

共通フローの「配置先確認」に従って、本文で配置先の選択肢を番号付きで提示して確認する:

- **プロジェクトレベル**（`_cursor/skills/`）: 特定プロジェクト固有のワークフロー
- **ユーザーレベル**（`_cursor_user/skills/`）: 全プロジェクト共通のワークフロー

### 5. Creator SubAgent に作成を委譲

`mt-cursor-config-creator` SubAgent を Task ツールで呼び出し、ファイル生成を委譲する。

prompt に以下を含める:

```text
mode: create
type: skill
template_path: [テンプレートの絶対パス]
output_path: [配置先の絶対パス]
fields: {
  "name": "[Skill名]",
  "description": "[description]",
  "prerequisite": "[前提知識の内容]",
  "steps": "[ステップの内容]",
  "completion_criteria": "[完了条件の内容]",
  "output": "[アウトプットの内容]",
  "notes": "[注意事項の内容]"
}

作成手順:
1. template_path のテンプレートを Read で読み込む
2. テンプレートのコメント（<!-- ... -->）を削除し、fields の値で frontmatter と本文を構成する
3. 不要なセクション（前提知識・アウトプットなど、値が空のもの）はセクションごと削除する
4. output_path に Write で出力する
5. 作成したファイルのパスと内容のサマリを返す
```

### 6. レビュー・改善ループ

共通フローの「レビュー・改善ループ」に従って、`mt-review-cursor-config` Skill と `mt-cursor-config-creator` SubAgent を使い品質を確保する。

### 7. 🟢 Nice to Have の確認

共通フローの「Nice to Have の確認」に従い、対応要否をユーザーに確認する。

### 8. 同期案内

共通フローの「同期案内」に従い、Skill の配置先に応じた同期コマンドを案内する。

## ✅ 完了条件

- Skill 定義ファイル（SKILL.md）が適切な配置先に作成されている
- Reviewer SubAgent のレビューで 🔴 Must Fix / 🟡 Should Fix がゼロ
- SKILL.md が 500 行以内に収まっている
- ユーザーが最終的な内容を確認・承認している

## ⚠️ 注意事項

- Skill にサブエージェントのペルソナ・行動原則が混入しないよう注意する
- 500 行を超える場合はリファレンスファイルへの分離を提案する（Progressive Disclosure）
- description は third-person で記述し、WHAT と WHEN の両方を含める
- フィールド収集で不足情報がある場合は、ユーザーへ確認してから Creator SubAgent に渡す
