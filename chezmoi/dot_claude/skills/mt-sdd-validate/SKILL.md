---
name: mt-sdd-validate
description: SDD の仕様適合検証フェーズを実行する。実装が仕様の受け入れ基準に適合しているかを機械的に検証する。SDD検証、mt-sdd-validate と言われた時に使用する。
---

# SDD 仕様適合検証（Phase 8）

実装が仕様に適合しているかを検証し、検証レポートを生成する。

## 🧠 前提知識

- セッション管理: [../mt-sdd/session.md](../mt-sdd/session.md) を参照
- SubAgent 実行プロトコル: [../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md) を参照
- UCR 処理: [../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) を参照
- テンプレート: [templates/appendix-validation-report.md](templates/appendix-validation-report.md)
- 関連 Skill: mt-check-branch-diff（差分取得に使用）

## 🏃 ステップ

### 事前準備

1. [../mt-sdd/session.md](../mt-sdd/session.md) を Read し、セッションディレクトリを特定する
    - スタンドアロン実行時: `tmp/mt-sdd/` 配下の最新ディレクトリをデフォルト候補として提示し、ユーザーに確認する
2. セッションディレクトリから `spec.md` を Read する

### Step 1: 差分取得

**mt-check-branch-diff Skill**（[../mt-check-branch-diff/SKILL.md](../mt-check-branch-diff/SKILL.md)）を使用して、ベースブランチとの差分を取得する。Skill が利用できない場合は `git diff` で直接取得する。

### Step 2: 検証実行

`mt-sdd-validator` SubAgent を `readonly: true` で起動する（[../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md)）。

> 検証用の差分は、オーケストレーターが Step 1 で取得したものをプロンプトに埋め込む。

**プロンプト構築**:

- Step 1 で取得した git diff 全文を埋め込む
- [templates/appendix-validation-report.md](templates/appendix-validation-report.md) のテンプレートを埋め込む
- `{session_dir}/spec.md` の受け入れ基準セクションを読むよう指示する
- 検証結果をテキストで出力させる（ファイル書き込みは不要）

### Step 3: 結果集約と報告

**オーケストレーターの作業**:

1. Validator の出力を確認し、`appendix-validation-report.md` を生成してセッションディレクトリに書き出す
2. **UCR 集約**: 検証結果に含まれる `[UCR]` プレフィックス付き報告から上流成果物の問題を抽出する。以下のケースで UCR が発生しうる:
    - 受け入れ基準が不適切・曖昧で判定不能 → spec.md への UCR
    - 仕様が技術的現実と乖離している → spec.md への UCR
    - 実装が計画と異なるが妥当な理由がある → implementation-plan.md への UCR（計画を実態に合わせる）
    - UCR がある場合、[../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) に従って処理する
3. 検証結果をユーザーに報告する
4. 不適合項目がある場合、修正方針をユーザーに提示する

## ✅ 完了条件

- すべての受け入れ基準に対して適合/不適合の判定が完了している
- 検証レポート（`appendix-validation-report.md`）が生成されている
- 不適合項目がある場合、修正方針がユーザーに提示されている

## 📦 アウトプット

セッションディレクトリに以下のファイルが生成される：

- `appendix-validation-report.md`（検証レポート）

## ⚠️ 注意事項

[../mt-sdd/common-guidelines.md](../mt-sdd/common-guidelines.md) を参照。
