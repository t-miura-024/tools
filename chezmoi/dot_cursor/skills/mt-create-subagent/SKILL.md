---
name: mt-create-subagent
description: 棲み分けガイドラインと個人テンプレートに基づいて対話的にSubAgent定義ファイルを作成する。ガイドライン判断フロー・SubAgent委譲・レビュー改善ループを含む。「SubAgent作成」「サブエージェント追加」「mt-create-subagent」と言われた時に使用する。
---

# SubAgent 作成

棲み分けガイドラインと個人テンプレートに基づいて、対話的に SubAgent 定義ファイルを作成する。

## 🧠 前提知識

- 棲み分けガイドライン: `_shared/cursor-config-guideline.md`
- SubAgent テンプレート: `_cursor_user/skills/mt-create-subagent/subagent-template.md`
- レビュー Skill: `_cursor_user/skills/mt-review-cursor-config/SKILL.md`
- 共通フロー: `_cursor_user/skills/_shared/create-my-config-workflow.md`

## 🏃 ステップ

### 1. 要求・要件分析

共通フローの「要求・要件分析」に従い、SubAgent 固有の観点として以下を把握する:

- **何を実現したいか**: どんなサブエージェントを定義したいか（専門性・役割）
- **なぜ必要か**: 親エージェントとコンテキストを分離する理由（客観性、重い処理の並列化など）
- **どんな場面で使うか**: どの Skill から呼び出されるか

### 2. ガイドライン判断

棲み分けガイドラインの簡易チェックリストで、SubAgent が適切な種類か確認する:

1. イベント駆動の自動処理か？　→ **Yes: Hook が適切**（この Skill では対象外。案内のみ）
2. 全セッション・全タスクで、無視されたら困る制約か？　→ **Yes: Rule が適切**（`mt-create-rule` を案内）
3. サブエージェントの Who 定義か？　→ **Yes: SubAgent が適切** ✅
4. 上記いずれでもない → **Skill が適切**（`mt-create-skill` を案内）

追加の確認: 本当にコンテキスト分離が必要か？

- 客観性が必要（レビュー、評価） → SubAgent が適切
- 重い処理の並列化が必要 → SubAgent が適切
- 上記いずれでもない → Skill で十分な可能性がある（ユーザーに確認）

SubAgent が適切でないと判断した場合、理由とともに別の種類を提案し、ユーザーに確認する。

### 3. フィールド収集

本文での選択肢提示と対話で SubAgent 固有のフィールドを収集する:

| フィールド           | 収集方法                                              |
| --------------- | ------------------------------------------------- |
| **name**        | SubAgent 名（kebab-case）を提案し確認                      |
| **description** | 役割を 1 文で（frontmatter 用）                           |
| **readonly**    | 選択肢: `true`（読み取り専用）/ `false`（ファイル作成・編集あり） |
| **color**       | 選択肢: `green`（readonly=false・実装系）/ `blue`（readonly=false・計画/調査系）/ `yellow`（readonly=true・レビュー/監査系）/ `red`（readonly=true・リスク/セキュリティ系）。readonly から適切な色を提案する |
| **ペルソナ**        | 「あなたは〜です」の形式で、専門性・役割・スタイルを定義                      |
| **責務スコープ**      | 何を担当するかを箇条書きで整理                                   |
| **制約・禁止事項**     | スコープ外の行動を明示的に列挙                                   |
| **行動原則**        | 判断に迷ったときの指針を 2〜3 項目で整理                            |
| **参照 Skill**    | 実行を委譲する Skill のパス                                 |

フィールド整理時は以下を確認する:

- 詳細な手順・ワークフローが混入していないか（→ Skill に委譲）
- 前提知識の詳細が混入していないか（→ Skill に含める）
- 「Who」の定義に徹しているか

### 4. 配置先確認

共通フローの「配置先確認」に従って、本文で配置先の選択肢を番号付きで提示して確認する:

- **プロジェクトレベル**（`_cursor/agents/`）: 特定プロジェクト固有のサブエージェント
- **ユーザーレベル**（`_cursor_user/agents/`）: 全プロジェクト共通のサブエージェント

### 5. Creator SubAgent に作成を委譲

`mt-cursor-config-creator` SubAgent を Task ツールで呼び出し、ファイル生成を委譲する。

prompt に以下を含める:

```text
mode: create
type: subagent
template_path: [テンプレートの絶対パス]
output_path: [配置先の絶対パス]
fields: {
  "name": "[SubAgent名]",
  "description": "[description]",
  "readonly": [true/false],
  "persona": "[ペルソナの内容]",
  "scope": "[責務スコープの内容]",
  "constraints": "[制約・禁止事項の内容]",
  "principles": "[行動原則の内容]",
  "referenced_skills": "[参照 Skill の内容]"
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

共通フローの「同期案内」に従い、`mt agent sync` で agent/skill を同期するよう案内する。

## ✅ 完了条件

- SubAgent 定義ファイルが適切な配置先に作成されている
- Reviewer SubAgent のレビューで 🔴 Must Fix / 🟡 Should Fix がゼロ
- 「Who」の定義に徹しており、詳細な手順が混入していない
- ユーザーが最終的な内容を確認・承認している

## ⚠️ 注意事項

- SubAgent に詳細な手順・ワークフローが混入しないよう注意する。手順は参照 Skill に委譲する
- 前提知識の詳細は SubAgent に書かず、参照先の Skill に含める
- 行動原則は 2〜3 項目の最小限に留める（過剰な原則は Skill に移す）
- readonly のデフォルトは true。ファイル書き込みが必要な場合のみ false にする
- フィールド収集で不足情報がある場合は、ユーザーへ確認してから Creator SubAgent に渡す
