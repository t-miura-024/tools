## 目的

計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。

## 方針

### 計画 Issue の妥当性検証

#### 1. 計画 Issue 番号の確認

ユーザーが指定した計画 Issue 番号 `<number>` を確認する（初回ヒアリングで取得済み）

#### 2. Issue の存在・状態の検証

Issue の存在・状態を検証する:

```bash
gh issue view <number> --json state,labels,number,title,url
```

- `kind/plan` label が付与されていることを確認
- `state` が `OPEN` であることを確認

#### 3. 計画 status の検証

`list-plans.ts` で status を確認し、`refined` または `in-progress` であることを検証する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/plan-run/list-plans.ts
```

- `draft` なら `plan-create` へ案内して中断
- `done` なら「完了済み。再開しますか？」と確認

#### 4. GitHub Sub Issue の確認

GitHub Sub Issue を確認する。Sub Issue を持つ親計画は実行できないため、子計画を選び直して中断する:

```bash
gh api repos/<owner>/<repo>/issues/<number>/sub_issues
```

### 状態遷移と Issue body の読み込み

#### 5. in-progress への遷移

`transition-plan.ts` を使って `refined` → `in-progress` に遷移する:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/shared/plan-transition-plan/main.ts <number> in-progress
```

既に `in-progress` の場合はスキップする。

#### 6. Issue body の読み込み

Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:

```bash
gh issue view <number> --json body
```

読み込んだ body を <SESSION>/issue-body.md にも保存する。

### 内容報告と番号保存

#### 7. 読み込み内容の要点報告

読み込んだ内容の要点を報告する:
   - 完了条件の数と概要
   - 主要な方針
   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）

#### 8. 計画番号と Issue body の保存

計画番号と Issue body を保存する。計画番号はセッションディレクトリの `plan-number.txt` に書き出し、report 時の `artifacts` に以下を含めること（申告漏れは check で fail になる）:
```json
[{"key": "plan-number.txt", "path": "<SESSION>/plan-number.txt"}, {"key": "issue-body.md", "path": "<SESSION>/issue-body.md"}]
```

## インプット

セッションディレクトリ: <SESSION>
