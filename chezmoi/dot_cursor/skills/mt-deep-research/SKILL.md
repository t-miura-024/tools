---
name: mt-deep-research
description: ローカル SearXNG、curl、pandoc、jq を使い、Planner / Researcher / Writer / Reviewer / Auditor の SubAgent オーケストレーションで自律的な多段探索（Deep Research）を行う。Researcher は問いごと、Reviewer は観点ごとに並列化する。中間生成物は SQLite（research.db）に保存し、人間が読むのは plan.md と report.md のみ。各フェーズ・サイクル後に監査 SubAgent を実行し、plan.md / report.md 作成時は lint + mermaid 構文チェックを通す。
---

# mt-deep-research

決定論的ワークフローエンジン（mt-workflow）で管理される Deep Research スキルです。

## 使い方

### 1. 事前ヒアリング

ユーザーから調査の背景・目的・前提知識を引き出す。
主要な問い・制約・スコープは Planner に任せる。

### 2. ワークフロー初期化

```bash
bun run ~/.cursor/skills/mt-workflow/cli.ts init \
  --workflow ~/.cursor/skills/mt-deep-research/workflow.ts \
  [--session <session-id>]
```

`beforeInit` で SearXNG/jq/pandoc/bun の前提チェック、`afterInit` で research.db の初期化が自動実行される。

### 3. ワークフロー実行

```bash
# 次のステップのプロンプトを取得
bun run ~/.cursor/skills/mt-workflow/cli.ts next --session <id>

# ステップ完了を報告
echo '{"stepKey":"...","status":"completed",...}' | \
  bun run ~/.cursor/skills/mt-workflow/cli.ts report --session <id>

# 状態確認
bun run ~/.cursor/skills/mt-workflow/cli.ts status --session <id>
```

`next` が返すプロンプトに従って SubAgent の起動・コマンド実行・Human Gate 応答を行う。

### 4. ワークフロー定義

フェーズ構成・チェックロジックの詳細は `workflow.ts` を参照。

| Phase | 内容 | タイプ |
|---|---|---|
| 3 | 計画立案（Planner） | task (subagent) |
| 4 | 調査（Researcher、並列） | task (orchestrate) |
| 5 | research サイクル監査 | task (orchestrate) |
| 6 | チェックポイント | human_gate |
| 7 | レポート作成（Writer） | task (subagent) |
| 8 | レビュー（Reviewer、並列 5 観点） | parallel |
| 9 | writer-reviewer サイクル監査 + 改善ループ | task (orchestrate) |
| 10 | 最終レポート確定 | task (orchestrate) |
| 11 | 完了報告 | task |

## 利用 SubAgent

| 役割 | SubAgent type | readonly | 責務 |
| --- | --- | --- | --- |
| Planner | `mt-deep-research-planner` | false | plan.md + questions テーブル |
| Researcher | `mt-deep-research-researcher` | false | evidence_rounds / sources / facts / off_topic_questions |
| Writer | `mt-deep-research-writer` | false | report.md |
| Reviewer | `mt-deep-research-reviewer` | true | reviews / review_findings |
| Auditor | `mt-deep-research-auditor` | true | サイクル監査 JSON 返却（書き込みは orchestrator） |

## 補助スクリプト

| スクリプト | 役割 |
| --- | --- |
| `scripts/db.ts` | SQLite CRUD / 一括保存 / snapshot |
| `scripts/audit.ts` | phase / cycle 監査の実行と永続化 |
| `scripts/lint.ts` | prettier + markdownlint + mermaid 構文チェック |
| `scripts/schema.sql` | SQLite スキーマ定義 |

## 出力

```
tmp/research/yyyymmdd-[topic]/
├── plan.md       # Planner が作成（人間が見る）
├── report.md     # Writer が作成（人間が見る）
└── research.db   # 中間生成物（SQLite）
```

## 前提ツール

| ツール | 役割 |
| --- | --- |
| SearXNG (localhost:8080) | ローカルメタ検索エンジン |
| `curl` | SearXNG API 呼び出し、HTML 取得 |
| `jq` | JSON 整形 |
| `pandoc` | HTML → Markdown 変換 |
| `bun` | 補助スクリプト実行（`bun:sqlite` 内蔵） |

```bash
mise run docker-up    # SearXNG 起動
mise run docker-down  # SearXNG 停止
```

## 注意事項

- SubAgent は最大 5 つまで同時起動
- Writer → Reviewer ループは 1 回のレポート更新あたり最大 3 回まで
- 監査は 1 フェーズあたり最大 3 回まで自動リトライ、それ以上は human gate で確認
- `plan.md` / `report.md` の作成後は必ず `lint.ts` を実行する
- 外部通信前に送信先・データ・目的を宣言する
- `report.md` の全文をセッションに出さない
