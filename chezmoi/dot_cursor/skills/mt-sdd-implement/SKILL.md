---
name: mt-sdd-implement
description: SDD の実装計画・レビュー・実装・コードレビューフェーズを実行する。実装計画作成・4観点レビュー・自動修正ループ・Process Auditor・計画確定・レイヤー順序でのタスク実行・コードレビュー・自動修正ループまでを行う。SDD実装、mt-sdd-implement、実装計画、mt-sdd-plan と言われた時に使用する。
---

# SDD 実装計画 + レビュー + 実装 + コードレビュー（Phase 4-7）

実装計画策定 → 計画レビュー（4 観点） → 自動修正ループ → Process Auditor → Human Gate 2（計画確定） → レイヤー順序で実装 → コードレビュー → 自動修正ループ → Human Gate 3（コードレビュー確定）。

## 🧠 前提知識

- セッション管理: [../mt-sdd/session.md](../mt-sdd/session.md) を参照
- SubAgent 実行プロトコル: [../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md) を参照
- レビュー基準: [review-criteria.md](review-criteria.md) を参照
- レビューフレームワーク: [../mt-sdd/review-framework.md](../mt-sdd/review-framework.md) を参照
- UCR 処理: [../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) を参照
- テンプレート: [templates/implementation-plan.md](templates/implementation-plan.md), [templates/appendix-plan-review.md](templates/appendix-plan-review.md), [templates/appendix-code-review.md](templates/appendix-code-review.md)
- 関連 Skill: mt-check-branch-diff（コードレビュー時の差分取得に使用）, mt-review-diff（コードレビュー観点の参照）

## 🏃 ステップ

### 事前準備

[../mt-sdd/session.md](../mt-sdd/session.md) を Read し、セッションディレクトリを作成または特定する。

### 入力ルーティング

以下の優先順序で入力モードを判定し、ワークフローの開始地点を決定する:

| 入力                                                     | 開始地点                                         |
| -------------------------------------------------------- | ------------------------------------------------ |
| セッションディレクトリに `implementation-plan.md` が存在 | Phase 6（実装）から                              |
| セッションディレクトリに `spec.md` が存在                | Phase 4（実装計画）から                          |
| ユーザーのテキスト指示のみ                               | コンテキスト収集 + 実装ヒアリング → Phase 4 から |

- `implementation-plan.md` が存在する場合、Phase 4-5 をスキップして Phase 6 から開始する
- `spec.md` が存在する場合、Phase 4 から開始する
- テキスト入力の場合、セッションディレクトリを新規作成し、コンテキスト収集 + 実装ヒアリングを経て Phase 4 から開始する

---

### テキスト入力時: コンテキスト収集 + 実装ヒアリング

> 入力ルーティングで `spec.md` も `implementation-plan.md` も存在しない場合のみ実行

#### Step 1: コンテキスト収集

`explore` SubAgent を `readonly: true` で起動し、実装計画に必要なコンテキストを収集する。

- ユーザーの要求概要を入力として渡し、関連コードの構造・パターン・影響範囲を調査させる

#### Step 2: 実装ヒアリング

**担当**: オーケストレーター（ユーザーとの直接対話）

Step 1 の収集結果とユーザーの初期要求を分析し、本文で質問・番号付き選択肢を提示して以下の観点でヒアリングを行う。

**ヒアリング観点**:

1. **実装内容の明確化**
    - 具体的に何を作る / 変更するか
    - 期待する動作・振る舞い（受け入れ基準に相当する情報）
    - 対象のユーザー・利用シーン

2. **技術的制約・方針の確認**
    - 使用すべき技術・ライブラリの指定や制約
    - 既存コードとの整合性で注意すべき点
    - パフォーマンス・セキュリティ上の考慮事項

3. **スコープの確定**
    - 今回の実装に含めるもの / 含めないもの
    - 影響範囲の認識合わせ

**ヒアリングのルール**:

- 選択肢で答えられる質問は本文で番号付き選択肢として提示し、自由記述が必要な質問はテキストで尋ねる
- 関連する質問は 1 回のメッセージにまとめて提示する（質問の往復回数を最小化する）
- 回答を受けて追加質問が必要な場合はループする（目安: 上限 3 往復）
- ユーザーの初期要求に十分な情報が含まれている場合は、該当する観点のヒアリングをスキップしてよい

オーケストレーターは、実装方針を左右する不明点だけを確認し、必要十分な情報を効率的に集める。

ヒアリング結果は Phase 4 で `spec.md` の代わりとして使用する。

---

### Phase 4: 実装計画

`mt-sdd-implementation-planner` SubAgent を起動する。

**プロンプト構築**:

- `{session_dir}/spec.md` を読むよう指示する（テキスト入力時はヒアリング結果 + コンテキスト収集結果を埋め込む）
- [templates/implementation-plan.md](templates/implementation-plan.md) のテンプレートを埋め込む
- コードベースの調査が必要な場合は自由に調査してよい旨を伝える

**タスク指示**: セッションディレクトリに `implementation-plan.md` を書き出す。

---

### Phase 5: 計画レビュー + 自動修正ループ

> 入力ルーティングで `implementation-plan.md` が存在する場合はスキップ

4 観点のレビュアーを `Subagent` tool call で **並列実行** する（[../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md) の並列実行パターン）。

各レビュアーのプロンプトに埋め込む内容:

| 観点             | SubAgent type | レビュー基準（[review-criteria.md](review-criteria.md)） |
| ---------------- | ------------- | -------------------------------------------------------- |
| 仕様適合         | `mt-sdd-spec-alignment-reviewer` | Spec Alignment |
| アーキテクチャ   | `mt-sdd-architecture-reviewer` | Architecture |
| タスク構造       | `mt-sdd-task-structure-reviewer` | Task Structure |
| リスク・影響範囲 | `mt-sdd-risk-impact-reviewer` | Risk/Impact |

共通のプロンプト指示:

- `readonly: true` で実行する
- [../mt-sdd/review-framework.md](../mt-sdd/review-framework.md) のコメントフォーマットを埋め込む
- `{session_dir}/implementation-plan.md` と `{session_dir}/spec.md` を読んでレビューするよう指示する（テキスト入力時は spec.md の代わりにヒアリング結果をプロンプトに埋め込む）
- レビューコメントをテキストで出力させる（ファイル書き込みは不要）

**オーケストレーターの作業**:

1. 4 つの `Subagent` tool call を同一メッセージで発行し、全レビュアーの結果を集約する
2. 各 SubAgent の出力を [templates/appendix-plan-review.md](templates/appendix-plan-review.md) に従って `appendix-plan-review.md` にまとめる
3. **UCR 集約**: レビューコメントから「上流変更要否: Yes」を抽出する。UCR がある場合、[../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) に従って処理する（Critical 自動修正ループの**前**に実行）
4. Critical 指摘の有無を判定:
    - **Critical あり** → `mt-sdd-implementation-planner` に現在の `implementation-plan.md` と Critical 指摘内容を渡して修正を指示 → 修正版で再度 Phase 5 実行
    - **Critical なし** → Process Auditor → Human Gate 2 へ

**出力**: セッションディレクトリに `appendix-plan-review.md` を書き出す。

---

### Process Auditor

`mt-sdd-process-auditor` SubAgent を `readonly: true` で起動する。

**プロンプト構築**:

- [../mt-sdd/process-auditor.md](../mt-sdd/process-auditor.md) の監査観点を埋め込む
- `{session_dir}/spec.md`（またはヒアリング結果）、`{session_dir}/implementation-plan.md`、`{session_dir}/appendix-plan-review.md` を読んで監査するよう指示する

**オーケストレーターの作業**: SubAgent の監査結果を確認し、`appendix-plan-review.md` の末尾に「監査サマリ」セクションとして追記する。

---

### Human Gate 2: 計画確定

ユーザーに以下の資料を提示する:

1. `implementation-plan.md`（実装計画書）
2. `appendix-plan-review.md`（レビューレポート + 監査サマリ）

本文で番号付き選択肢として以下を提示する:

| 選択肢       | 動作                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **承認**     | Phase 6（実装）へ進む                                                                                                                        |
| **修正指示** | ユーザーのフィードバックと現在の `implementation-plan.md` を `mt-sdd-implementation-planner` に渡して修正を指示 → Phase 5 から再実行 |
| **中止**     | ワークフロー終了                                                                                                                             |

「修正指示」が選択された場合、テキストで具体的な修正内容をヒアリングする。

---

### Phase 6: 実装

`implementation-plan.md` のタスク一覧をレイヤーごとに解析し、`mt-sdd-implementer` SubAgent を起動して実装する。

#### レイヤー順序

```text
Layer 1 (Infrastructure): DB マイグレーション、設定ファイル等
    ↓
Layer 2 (Backend - TDD): テスト作成 → Red → 実装 → Green
    ↓
Layer 3 (Frontend): UI コンポーネント、画面実装等
```

#### 実行ルール

**レイヤー単位で入力を整理する**。各タスクの実行時に、対象タスク、関連仕様、既に完了した同一レイヤー内タスク、維持すべき制約を prompt に含める。

**実装タスク開始時のプロンプト構築**:

- `{session_dir}/implementation-plan.md` と `{session_dir}/spec.md` を読むよう指示する（テキスト入力時は spec.md の代わりにヒアリング結果を埋め込む）
- 実行対象タスクの定義と実装指示を渡す
- 同一レイヤー内の完了済みタスクがある場合は、その要約を渡す

**レイヤー内タスク継続時**:

- 必要に応じて `Subagent` の `resume` を使う。ただし、通常は成果物ファイル、完了済みタスク要約、次タスク定義を prompt に含めて再委譲する
- 異なるレイヤーへ移る場合は、新しい実行文脈として必要入力を明示する

各タスクには以下を明確にした上で実装させる:

- 担当タスクの定義（`implementation-plan.md` から抽出）
- `spec.md` の該当セクション（関連する機能仕様・受け入れ基準）
- 仕様にないことは実装しない原則

**UCR 検出**: Implementer の出力に `[UCR]` プレフィックス付きの報告が含まれている場合、オーケストレーターは [../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) に従って UCR 処理を実行する。UCR 処理後、残りのタスク実行への影響を評価し、必要に応じてタスク実行順序を調整する。

---

### Phase 7: コードレビュー + 自動修正ループ

Phase 6 の実装完了後、実装済みコードの品質をレビューする。

#### Step 1: 差分取得

**mt-check-branch-diff Skill**（[../mt-check-branch-diff/SKILL.md](../mt-check-branch-diff/SKILL.md)）を使用して、ベースブランチとの差分を取得する。Skill が利用できない場合は `git diff` で直接取得する。

#### Step 2: コードレビュー

`mt-sdd-code-reviewer` SubAgent を `readonly: true` で起動する。

> レビュー用の差分は、オーケストレーターが Step 1 で取得したものをプロンプトに埋め込む。

**プロンプト構築**:

- Step 1 で取得した git diff 全文を埋め込む
- [../mt-review-diff/code-review-criteria.md](../mt-review-diff/code-review-criteria.md) のレビュー観点を埋め込む
- [../mt-sdd/review-framework.md](../mt-sdd/review-framework.md) のコメントフォーマットを埋め込む
- `{session_dir}/spec.md` と `{session_dir}/implementation-plan.md` を読むよう指示する（テキスト入力時は spec.md の代わりにヒアリング結果を埋め込む）
- レビューコメントをテキストで出力させる（ファイル書き込みは不要）

#### Step 3: UCR 集約 + 自動修正ループ

**オーケストレーターの作業**:

1. Code Reviewer の出力を確認し、[templates/appendix-code-review.md](templates/appendix-code-review.md) に従って `appendix-code-review.md` を生成
2. **UCR 集約**: レビューコメントから「上流変更要否: Yes」を抽出する。UCR がある場合、[../mt-sdd/upstream-change-protocol.md](../mt-sdd/upstream-change-protocol.md) に従って処理する（Critical 自動修正ループの**前**に実行）
3. Critical 指摘の有無を判定:
    - **Critical あり** → `mt-sdd-implementer` に現在の差分、該当タスク、Critical 指摘内容を渡して修正を指示 → 修正後に Step 1 から再実行（差分の再取得が必要）
    - **Critical なし** → Human Gate 3 へ

**出力**: セッションディレクトリに `appendix-code-review.md` を書き出す。

---

### Human Gate 3: コードレビュー確定

ユーザーに以下の資料を提示する:

1. `appendix-code-review.md`（コードレビューレポート）

本文で番号付き選択肢として以下を提示する:

| 選択肢       | 動作                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **承認**     | 完了。次のフェーズ（mt-sdd-validate）へ進むよう案内する                                                                   |
| **修正指示** | ユーザーのフィードバックと現在の差分を `mt-sdd-implementer` に渡して修正を指示 → Phase 7 の Step 1 から再実行 |
| **中止**     | ワークフロー終了                                                                                                       |

「修正指示」が選択された場合、テキストで具体的な修正内容をヒアリングする。

## ✅ 完了条件

- 実装計画（`implementation-plan.md`）がユーザーに承認されている
- 全レイヤーの実装タスクが完了している
- コードレビューをパスし、ユーザーに承認されている

## 📦 アウトプット

セッションディレクトリに以下のファイルが生成される：

- `implementation-plan.md`（実装計画書）
- `appendix-plan-review.md`（計画レビューレポート + 監査サマリ）
- `appendix-code-review.md`（コードレビューレポート）
- 実装済みソースコード

## ⚠️ 注意事項

[../mt-sdd/common-guidelines.md](../mt-sdd/common-guidelines.md) を参照。
