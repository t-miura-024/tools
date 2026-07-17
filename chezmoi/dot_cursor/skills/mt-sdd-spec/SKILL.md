---
name: mt-sdd-spec
description: SDD の仕様策定・レビューフェーズを実行する。コンテキスト収集・要求ヒアリング・仕様書作成・4観点レビュー・自動修正ループ・Process Auditor・仕様確定までを行う。SDD仕様策定、mt-sdd-spec、要求分析、mt-sdd-analyze と言われた時に使用する。
---

# SDD 仕様策定 + レビュー（Phase 1-2）

コンテキスト収集 → 要求ヒアリング → 仕様書作成 → 仕様レビュー（4 観点） → 自動修正ループ → Process Auditor → Human Gate（仕様確定）を実行する。

## 🧠 前提知識

- セッション管理: [../mt-sdd/session.md](../mt-sdd/session.md) を参照
- SubAgent 実行プロトコル: [../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md) を参照
- レビュー基準: [review-criteria.md](review-criteria.md) を参照
- レビューフレームワーク: [../mt-sdd/review-framework.md](../mt-sdd/review-framework.md) を参照
- テンプレート: [templates/spec.md](templates/spec.md), [templates/appendix-hearing-log.md](templates/appendix-hearing-log.md), [templates/appendix-spec-review.md](templates/appendix-spec-review.md)

## 🏃 ステップ

### 事前準備

[../mt-sdd/session.md](../mt-sdd/session.md) を Read し、セッションディレクトリを作成または特定する。

### 入力ルーティング

以下の優先順序で入力モードを判定し、ワークフローの開始地点を決定する:

| 入力                                      | 開始地点                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| セッションディレクトリに `spec.md` が存在 | Phase 2（仕様レビュー）から                               |
| ユーザーのテキスト指示のみ                | Phase 1（コンテキスト収集 + ヒアリング + 仕様書作成）から |

- `spec.md` が存在する場合、Phase 1 をスキップして Phase 2 から開始する
- テキスト入力の場合、セッションディレクトリを新規作成し、Phase 1 から開始する

---

### Phase 1: 仕様策定

> 入力ルーティングで `spec.md` が存在する場合はスキップ

#### Step 1: コンテキスト収集

以下の入力収集を行い、結果を Step 3 の Spec Writer prompt に渡す。

1. **Codebase Explorer**: `explore` SubAgent を `readonly: true` で起動する
    - ユーザーの要求概要を入力として渡し、関連コードの構造・パターンを調査させる
2. **外部ソース取得**: 外部ソース URL がある場合のみ、オーケストレーターが MCP 優先で取得する
    - Notion、Figma、GitHub など、利用可能な MCP があるデータソースは MCP を優先する
    - 取得結果を要件情報として構造化し、曖昧な点は「不明」と明示する

#### Step 2: 要求ヒアリング

**担当**: オーケストレーター（ユーザーとの直接対話）

Step 1 の収集結果とユーザーの初期要求を分析し、本文で質問・番号付き選択肢を提示して以下の観点でヒアリングを行う。

用語の確定や ADR が必要な論点では `mt-grill-with-docs` の規則を使う:

- 確定した用語は `CONTEXT.md` にその場で残す
- 覆しにくいトレードオフは ADR を提案する
- 会話から仕様を合成する場合も、未確認事項を推測で埋めない

**ヒアリング観点**:

1. **背景・ニーズの深堀り**
    - なぜこの機能が必要か（ビジネス上の目的・課題）
    - 誰が使うか（ユーザー種別・利用シーン）
    - どんな課題を解決したいか（現状の Pain Point）
    - 期待する成果・ゴール

2. **不足情報・疑問点の確認**
    - Step 1 で収集した情報と入力された要求を照合し、実装方針を決めるために不足している情報を特定する
    - 要求の曖昧な部分や複数の解釈が可能な箇所を質問する
    - 技術的制約・非機能要件（パフォーマンス、セキュリティなど）で明示されていないものを確認する

3. **本質的解決策の提案**
    - 背景・ニーズを踏まえて、要求された方法より本質的・効果的な解決策がある場合は代替案を提示する
    - 代替案を提示する際は、各選択肢のメリット・デメリットを明示し、ユーザーに選択を求める

**ヒアリングのルール**:

- 選択肢で答えられる質問は本文で番号付き選択肢として提示し、自由記述が必要な質問はテキストで尋ねる
- 関連する質問は 1 回のメッセージにまとめて提示する（質問の往復回数を最小化する）
- 回答を受けて追加質問が必要な場合はループする（目安: 上限 3 往復）
- ユーザーの初期要求に十分な背景情報が含まれている場合は、該当する観点のヒアリングをスキップしてよい

オーケストレーターは、Step 1 の収集結果をもとに既存パターンの再利用案や本質的な代替案を先に提示し、ユーザーの判断が必要な論点だけを確認する。

#### Step 3: 仕様書 + ヒアリング記録の生成

`mt-sdd-spec-writer` SubAgent を起動し、以下の 2 ファイルを生成させる。

**プロンプト構築**:

- Step 1 の収集結果（Codebase Explorer / 外部ソース取得の構造化結果）を埋め込む
- Step 2 のヒアリング結果 + ユーザーの口頭指示を埋め込む
- [templates/spec.md](templates/spec.md) のテンプレートを埋め込む
- [templates/appendix-hearing-log.md](templates/appendix-hearing-log.md) のテンプレートを埋め込む
- 推測補完の記録ルールを明示する

**タスク指示**: セッションディレクトリに `spec.md` と `appendix-hearing-log.md` を書き出す。

---

### Phase 2: 仕様レビュー + 自動修正ループ

4 観点のレビュアーを `Subagent` tool call で **並列実行** する（[../mt-sdd/subagent-protocol.md](../mt-sdd/subagent-protocol.md) の並列実行パターン）。

各レビュアーのプロンプトに埋め込む内容:

| 観点       | SubAgent type | レビュー基準（[review-criteria.md](review-criteria.md)） |
| ---------- | ------------- | -------------------------------------------------------- |
| 網羅性     | `mt-sdd-completeness-reviewer` | Completeness |
| 実現可能性 | `mt-sdd-feasibility-reviewer` | Feasibility |
| 一貫性     | `mt-sdd-consistency-reviewer` | Consistency |
| リスク     | `mt-sdd-risk-reviewer` | Risk |

共通のプロンプト指示:

- `readonly: true` で実行する
- [../mt-sdd/review-framework.md](../mt-sdd/review-framework.md) のコメントフォーマットを埋め込む
- `{session_dir}/spec.md` を読んでレビューするよう指示する
- レビューコメントをテキストで出力させる（ファイル書き込みは不要）

**オーケストレーターの作業**:

1. 4 つの `Subagent` tool call を同一メッセージで発行し、全レビュアーの結果を集約する
2. 各 SubAgent の出力を [templates/appendix-spec-review.md](templates/appendix-spec-review.md) に従って `appendix-spec-review.md` にまとめる
3. Critical 指摘の有無を判定:
    - **Critical あり** → `mt-sdd-spec-writer` に現在の `spec.md` と Critical 指摘内容を渡して修正を指示 → 修正版で再度 Phase 2 実行
    - **Critical なし** → Process Auditor → Human Gate へ

**出力**: セッションディレクトリに `appendix-spec-review.md` を書き出す。

---

### Process Auditor

`mt-sdd-process-auditor` SubAgent を `readonly: true` で起動する。

**プロンプト構築**:

- [../mt-sdd/process-auditor.md](../mt-sdd/process-auditor.md) の監査観点を埋め込む
- `{session_dir}/spec.md` と `{session_dir}/appendix-spec-review.md` を読んで監査するよう指示する

**オーケストレーターの作業**: SubAgent の監査結果を確認し、`appendix-spec-review.md` の末尾に「監査サマリ」セクションとして追記する。

---

### Human Gate: 仕様確定

ユーザーに以下の資料を提示する:

1. `spec.md`（仕様書）
2. `appendix-spec-review.md`（レビューレポート + 監査サマリ）

**推測補完の確認**: `appendix-hearing-log.md` の「推測補完した仕様」セクションに項目がある場合、Human Gate の冒頭でその一覧をユーザーに提示し、各項目の採否を確認する。ユーザーが不要と判断した項目は `spec.md` から削除する。

本文で番号付き選択肢として以下を提示する:

| 選択肢       | 動作                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **承認**     | 完了。次のフェーズ（mt-sdd-implement）へ進むよう案内する                                                                             |
| **修正指示** | ユーザーのフィードバックと現在の `spec.md` を `mt-sdd-spec-writer` に渡して修正を指示 → Phase 2 から再実行 |
| **中止**     | ワークフロー終了                                                                                                                  |

「修正指示」が選択された場合、テキストで具体的な修正内容をヒアリングする。

## ✅ 完了条件

- 仕様書（`spec.md`）がユーザーに承認されている
- レビューレポート（`appendix-spec-review.md`）が生成されている
- ヒアリング記録（`appendix-hearing-log.md`）が生成されている

## 📦 アウトプット

セッションディレクトリに以下のファイルが生成される：

- `spec.md`（仕様書）
- `appendix-hearing-log.md`（ヒアリング記録）
- `appendix-spec-review.md`（仕様レビューレポート + 監査サマリ）

## ⚠️ 注意事項

[../mt-sdd/common-guidelines.md](../mt-sdd/common-guidelines.md) を参照。
