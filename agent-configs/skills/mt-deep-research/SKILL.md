---
name: mt-deep-research
description: ローカル SearXNG、curl、pandoc、jq を使い、Planner / Researcher / Writer / Reviewer / Auditor の SubAgent オーケストレーションで自律的な多段探索（Deep Research）を行う。Researcher は問いごと、Reviewer は観点ごとに並列化する。中間生成物は SQLite（research.db）に保存し、人間が読むのは plan.md と report.md のみ。各フェーズ・サイクル後に監査 SubAgent を実行し、plan.md / report.md 作成時は lint + mermaid 構文チェックを通す。
---

# mt-deep-research

ローカル SearXNG インスタンス、`curl`、`pandoc`、`jq`、**TypeScript + bun** を使い、**Planner / Researcher / Writer / Reviewer / Auditor** の 5 つの SubAgent をオーケストレーションして、自律的な多段探索（Deep Research）を行う。

調査成果物は **`tmp/research/yyyymmdd-[topic]/research.db`**（SQLite）に集約する。人間に見せるのは **`plan.md` と `report.md` のみ**。evidence / reviews / audits / iterations / logs などの**中間生成物はすべて SQLite に閉じる**。

## 🧠 前提知識

### 利用するツール

| ツール | 役割 |
| --- | --- |
| SearXNG (localhost:8080) | ローカルで動作するメタ検索エンジン |
| `curl` | SearXNG API の呼び出し、公開 URL の HTML 取得 |
| `jq` | SearXNG API の JSON レスポンス整形 |
| `pandoc` | 取得した HTML を Markdown に変換 |
| `bun` | 補助スクリプトの実行環境（`scripts/db.ts` / `audit.ts` / `lint.ts`） |
| `bun:sqlite` | 中間生成物を保存する組み込み SQLite |

### SearXNG の起動

SearXNG は Docker Compose で管理する。リポジトリの `docker/` ディレクトリから起動する。

```bash
mise run docker-up
mise run docker-down
```

前提チェック:

```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"
```

`jq` / `pandoc` / `bun` の確認:

```bash
command -v jq
command -v pandoc
command -v bun
```

`bun` が無い場合は `brew install oven-sh/bun/bun`（macOS）または `mise use bun` で導入する。

### bun 依存パッケージのセットアップ

`scripts/` 配下には `package.json` が存在する。初回実行時に `node_modules` が無ければ `scripts/` ディレクトリで `bun install` を自動実行する。**Skill 実行ごとにグローバル環境を汚さない**ように、依存は `scripts/` 内に閉じる。

### 外部通信の扱い

この Skill は SearXNG 経由で Web 検索し、公開 URL を取得する。実行前に以下を必ず宣言する。

- 送信先: ローカル SearXNG、または取得対象の公開 URL
- 送信データ: 検索クエリ、または指定 URL
- 目的: 検索結果取得、またはページ本文取得

ファイルアップロード、外部 POST / PUT、認証付きリクエストは行わない。社内情報・顧客情報・秘密情報をクエリや URL に含めない。

## 📂 出力ディレクトリと命名

```
tmp/research/yyyymmdd-[topic]/
├── plan.md                 # Planner が作成（人間が見る）
├── report.md               # Writer が作成（人間が見る）
├── research.db             # 中間生成物を格納する SQLite
└── ...                     # その他のファイルは research.db 内に閉じる
```

同日・同テーマで既にディレクトリが存在する場合は、連番を付与する。

### 人間が見るファイル

| ファイル | 作成者 | 用途 |
| --- | --- | --- |
| `plan.md` | Planner | 研究計画書（mermaid を含む） |
| `report.md` | Writer | 最終レポート（mermaid を含む） |

### SQLite に閉じる中間生成物

| テーブル | 主な用途 |
| --- | --- |
| `questions` | Planner が提案する主要な問い |
| `evidence_rounds` | 各問いの調査ラウンド |
| `sources` | 情報源 |
| `facts` | 抽出事実 |
| `off_topic_questions` | 目的外問い |
| `reviews` | 観点ごとのレビュー結果 |
| `review_findings` | must_fix / research_needed / suggestions |
| `audits` | 監査結果 |
| `audit_checks` | 個別監査チェック |
| `iterations` | 改善ループ履歴 |
| `execution_logs` | スクリプト実行ログ |

## 🏃 フェーズ別ワークフロー

### Phase 0: 前提チェック

```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"
command -v jq && command -v pandoc && command -v bun
ls agent-configs/skills/mt-deep-research/scripts/node_modules 2>/dev/null || \
  (cd agent-configs/skills/mt-deep-research/scripts && bun install)
```

SearXNG / `jq` / `pandoc` / `bun` のいずれかが無ければ中断して案内する。

### Phase 1: 事前ヒアリング

ユーザーから以下を引き出す。質問は 1 つずつ。

1. **調査の背景・目的**: なぜこの調査が必要か、何に使うか
2. **既に知っている前提知識**: 既知の情報、過去に調べた内容

**主要な問いは Planner に任せる**。制約・スコープも Planner の plan.md で提案させる。

### Phase 2: ディレクトリ作成 + DB 初期化

```bash
WORK=tmp/research/yyyymmdd-[topic]
mkdir -p "$WORK"
bun run agent-configs/skills/mt-deep-research/scripts/db.ts init \
  --db-path "$WORK/research.db"
```

`node_modules` が無ければ先に `bun install` を `scripts/` 内で実行する。

### Phase 3: 計画立案（Planner）

`mt-deep-research-planner` を 1 つ起動する。

**入力**: 背景・目的・前提知識・制約

**期待する成果物**:

1. `questions` テーブルへの問い登録（3〜7 個、5 個までを推奨）
2. `plan.md` の作成（`templates/plan.md` 構成に従う）

**オーケストレーターの処理**:

```bash
# Planner 完了後、ファイル lint + 機械監査を実行
bun run scripts/lint.ts --file "$WORK/plan.md"
bun run scripts/audit.ts phase --phase planner \
  --db-path "$WORK/research.db" --plan-path "$WORK/plan.md"
```

監査 NG の場合は Planner にフィードバックして**最大 3 回**まで再委譲する。3 回を超えても NG の場合は人間に「範囲を狭める」「このまま進める」「中断する」を提示する。

`plan.md` の要約（背景・目的・問い・制約・検索戦略）をユーザーに提示し、承認を得る。承認後:

```bash
# 承認された問いの status を更新
for id in $approved_ids; do
  bun run scripts/db.ts question update --id "$id" --status approved --db-path ...
done
```

### Phase 4: 調査（Researcher、並列）

`mt-deep-research-researcher` を**承認された問いごと**に並列起動する（最大 5 同時）。

**入力**: `question_id`、`db.ts snapshot --cycle research` の出力

**期待する成果物**:

- `evidence_rounds` / `sources` / `facts` / `off_topic_questions` への一括保存

各 Researcher のループは最大 5 ラウンド。ラウンドを跨ぐ場合は `round_number` をインクリメントする。

**オーケストレーターの処理（各 Researcher 完了後）**:

```bash
bun run scripts/audit.ts phase --phase researcher \
  --db-path "$WORK/research.db" --question-id "$qid"
```

NG の場合は該当 Researcher にフィードバックして**最大 3 回**まで再委譲する。

### Phase 5: research サイクル監査

すべての Researcher 完了後:

```bash
bun run scripts/audit.ts cycle --cycle research \
  --db-path "$WORK/research.db"
```

監査 NG かつ自動リトライ不能な場合は、`mt-deep-research-auditor` を呼び出して**意味的整合性**を評価させる。Auditor の出力 JSON は `db.ts audit save` で SQLite に保存する。

### Phase 6: チェックポイント（任意）

`off_topic_questions` を集約し、ユーザーに「追加調査するか」「除外するか」を確認する。確定したら `db.ts` 経由で `decision` を `include` / `exclude` に更新する。

### Phase 7: レポート作成（Writer）

`mt-deep-research-writer` を 1 つ起動する。

**入力**: `db.ts snapshot --cycle writer-reviewer` の出力

**期待する成果物**:

- `report.md` の作成・更新（`templates/report.md` 構成に従う、mermaid 必須）

**オーケストレーターの処理**:

```bash
bun run scripts/lint.ts --file "$WORK/report.md"
bun run scripts/audit.ts phase --phase writer \
  --db-path "$WORK/research.db" --report-path "$WORK/report.md"
```

### Phase 8: レビュー（Reviewer、並列）

`mt-deep-research-reviewer` を**5 観点すべて並列**で起動する。

**入力**: 担当観点、`db.ts snapshot --cycle writer-reviewer` の出力

**期待する成果物**:

- `reviews` / `review_findings` テーブルへの JSON 保存（`db.ts review save`）

**オーケストレーターの処理（各 Reviewer 完了後）**:

```bash
bun run scripts/audit.ts phase --phase reviewer --db-path "$WORK/research.db"
```

### Phase 9: writer-reviewer サイクル監査 + 改善ループ

```bash
bun run scripts/audit.ts cycle --cycle writer-reviewer \
  --db-path "$WORK/research.db" --report-path "$WORK/report.md"
```

監査 NG の場合:

- `must_fix` あり → Writer に集約プロンプトで再委譲（最大 3 回）
- `research_needed` あり → 問いごとに Researcher に追加調査を依頼（最大 3 ラウンド）
- 両方あり → 両方実施

1 回の report.md 更新あたり Writer → Reviewer のループは最大 3 回。3 回を超えて NG が残る場合は人間に判断を仰ぐ。

改善ループの結果は `iterations` テーブルに記録する:

```bash
bun run scripts/db.ts iteration save --db-path ... --data '{
  "loop_number": 1,
  "iteration_type": "writer_fix" | "researcher_revisit" | "audit_retry",
  "triggered_by_audit": <audit_id>,
  "summary": "..."
}'
```

### Phase 10: 最終レポート確定

`report.md` を最終更新し、`scripts/lint.ts` で再フォーマット・再 lint する。レポートに未解決の問い・次のアクション・中間まとめ・SearXNG 信頼性注意書きを含めない。

```bash
bun run scripts/lint.ts --file "$WORK/report.md"
bun run scripts/audit.ts cycle --cycle writer-reviewer \
  --db-path "$WORK/research.db" --report-path "$WORK/report.md"
```

### Phase 11: 完了報告

`report.md` の全文はセッションに出さない。完了メッセージは簡潔に:

```
調査が完了しました。N 件の情報源を確認しました。レポートは tmp/research/yyyymmdd-[topic]/report.md に保存しました。
```

## 🤖 利用 SubAgent

| 役割 | SubAgent type | readonly | 責務 |
| --- | --- | --- | --- |
| Planner | `mt-deep-research-planner` | false | plan.md + questions テーブル |
| Researcher | `mt-deep-research-researcher` | false | evidence_rounds / sources / facts / off_topic_questions |
| Writer | `mt-deep-research-writer` | false | report.md |
| Reviewer | `mt-deep-research-reviewer` | true | reviews / review_findings |
| Auditor | `mt-deep-research-auditor` | true | サイクル監査 JSON 返却（書き込みは orchestrator） |

prompt 構造、並列化、Human Gate、監査タイミング、改良ループの詳細は `subagent-protocol.md` を参照。

## 🧰 補助スクリプト

| スクリプト | 役割 |
| --- | --- |
| `scripts/db.ts` | SQLite CRUD / 一括保存 / snapshot |
| `scripts/audit.ts` | phase / cycle 監査の実行と永続化 |
| `scripts/lint.ts` | prettier + markdownlint + mermaid 構文チェック |
| `scripts/schema.sql` | SQLite スキーマ定義 |
| `scripts/markdownlint.json` | markdownlint ルール設定 |

### 主要コマンド早見表

```bash
# 初期化
bun run scripts/db.ts init --db-path "$WORK/research.db"

# 問い
bun run scripts/db.ts question create --content "..." --order 1 --db-path ...
bun run scripts/db.ts question list --db-path ...
bun run scripts/db.ts question update --id N --status approved --db-path ...

# 調査（Researcher が実行）
bun run scripts/db.ts evidence save --data '{...}' --db-path ...

# スナップショット（SubAgent への入力）
bun run scripts/db.ts snapshot --cycle research --db-path ...
bun run scripts/db.ts snapshot --cycle writer-reviewer --db-path ... --report-path ...

# レビュー（Reviewer が実行）
bun run scripts/db.ts review save --data '{...}' --db-path ...

# 監査
bun run scripts/audit.ts phase --phase planner --db-path ... --plan-path ...
bun run scripts/audit.ts phase --phase researcher --db-path ... [--question-id N]
bun run scripts/audit.ts phase --phase writer --db-path ... --report-path ...
bun run scripts/audit.ts phase --phase reviewer --db-path ...
bun run scripts/audit.ts cycle --cycle research --db-path ...
bun run scripts/audit.ts cycle --cycle writer-reviewer --db-path ... --report-path ...

# Lint / Format
bun run scripts/lint.ts --file "$WORK/plan.md"
bun run scripts/lint.ts --file "$WORK/report.md"

# イテレーション
bun run scripts/db.ts iteration save --data '{...}' --db-path ...
```

## ✅ 完了条件（カテゴリ別）

### プロセス完了

- [ ] Phase 0 の前提チェックが全て OK
- [ ] Phase 1 のヒアリングが完了し、背景・目的・前提知識が明確
- [ ] Phase 2 で `research.db` が初期化済み
- [ ] Phase 3 で `plan.md` と `questions` テーブルが完成し、ユーザー承認済み
- [ ] Phase 4 で全問いの `evidence_rounds` が完成
- [ ] Phase 5 の research サイクル監査が pass
- [ ] Phase 6 の目的外問いがチェックポイントで確定
- [ ] Phase 7 で `report.md` が完成
- [ ] Phase 8 で 5 観点すべての `reviews` が完成
- [ ] Phase 9 で writer-reviewer サイクル監査が pass（must_fix 解消済み）
- [ ] Phase 10 で最終 `report.md` が lint 済み

### 成果物

- [ ] `plan.md` に必須セクションが全て揃い、mermaid ブロックが存在する
- [ ] `report.md` に必須セクションが全て揃い、mermaid ブロックが存在する
- [ ] `report.md` 内の番号引用 `[N]` が `sources.source_number` と一致する
- [ ] `report.md` に未解決の問い・次のアクション・中間まとめが含まれない
- [ ] 中間生成物（evidence / reviews / audits / logs）は SQLite に閉じている

### セキュリティ・運用

- [ ] 検索クエリ・URL に秘密情報を含めていない
- [ ] 外部通信前に送信先・送信データ・目的を宣言済み
- [ ] セッションに `report.md` の全文を出力していない
- [ ] `research.db` を含む調査ディレクトリが `.gitignore` 対象である

## ⚠️ 注意事項

- SubAgent は最大 5 つまで同時起動（Researcher・Reviewer とも）
- Writer → Reviewer ループは 1 回のレポート更新あたり最大 3 回まで
- 監査は 1 フェーズあたり最大 3 回まで自動リトライ、それ以上は人間に判断を仰ぐ
- `plan.md` / `report.md` の作成・最終更新後は必ず `lint.ts` を実行する
- 監査結果と SubAgent の出力が矛盾する場合は、監査結果を優先して再委譲する
