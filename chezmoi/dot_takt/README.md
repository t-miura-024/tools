# dot_takt — TAKT ワークフロー設定（mt-run-plan）

既存の opencode `mt-run-plan` Skill の振る舞いを TAKT ワークフローとして実装した資材セット。

## 目的

`mt-run-plan` の「承認済み計画の検証 → 実行 → 5 観点並列レビュー → fix ループ → COMPLETE → TAKT による commit/push/PR 作成」というライフサイクルを TAKT の宣言的ワークフローで実現する。GitHub Project Workflow で PR-Issue 紐付けをトリガーに自動 Done 化する。

## ディレクトリ構成

```
~/.takt/                       (dot_takt/ から chezmoi apply で展開)
├── config.yaml                # TAKT 本体設定 + workflow_categories
├── workflows/
│   └── mt-run-plan.yaml       # 計画実行ワークフロー
├── facets/
│   ├── personas/              # WHO — ロール定義
│   │   ├── executor.md
│   │   ├── reviewer-essence.md
│   │   ├── reviewer-completeness.md
│   │   ├── reviewer-scope.md
│   │   ├── reviewer-policy.md
│   │   ├── reviewer-quality.md
│   │   └── supervisor.md
│   ├── policies/              # RULES — ルール・品質基準
│   │   ├── execution.md
│   │   └── review.md
│   ├── instructions/          # WHAT — 手順
│   │   ├── validate-plan.md
│   │   ├── start-execution.md
│   │   ├── execute.md
│   │   ├── review-essence.md
│   │   ├── review-completeness.md
│   │   ├── review-scope.md
│   │   ├── review-policy.md
│   │   ├── review-quality.md
│   │   ├── fix.md
│   │   └── update-history.md
│   ├── knowledge/             # CONTEXT — 参照資料
│   │   └── plan-format.md
│   └── output-contracts/      # OUTPUT — 出力フォーマット
│       ├── review-verdict.md
│       └── execution-report.md
└── scripts/                   # 状態遷移スクリプト
    ├── transition-plan.ts
    ├── list-plans.ts
    ├── init-config.ts
    ├── init-config-gh.ts
    ├── *.test.ts
    ├── package.json
    └── bun.lock
```

## ワークフロー

### mt-run-plan（計画実行）

```
validate-plan (Issue 検証)
  → start-execution (transition-plan.ts で in-progress へ)
  → execute (方針ベース実行, edit: true, requires_user_input)
  → reviewers (5 観点の並列レビュー, edit: false)
      ├─ essence (本質性・効率性)
      ├─ completeness (完了条件の充足)
      ├─ scope (スコープ遵守)
      ├─ policy (方針との整合)
      └─ quality (アウトプット品質)
  → fix (any("needs_fix") の場合, 修正実行)
  → COMPLETE (all("approved") の場合)
  → TAKT エンジンが commit/push/PR 作成（`Closes #N` 自動付与）
  → GitHub Project Workflow が Issue を done へ自動遷移

loop_monitors:
  cycle: [execute, reviewers, fix]
  threshold: 3
  judge: supervisor (進捗判定, 無限ループ防止)
```

## 起動方法

```bash
# 実行対象の計画 Issue をキューに登録（worktree + auto_pr を有効化）
takt add #N
# プロンプトで workflow: mt-run-plan, worktree: yes/Enter, Auto-PR: yes を選択

# キューに登録されたタスクを実行
takt run
```

- `takt add #N` で Issue 内容を task として保存し、`auto_pr: true` にしておくと、`takt run` 完了後に PR が自動作成されます。
- PR body には `Closes #N` が自動付与され、GitHub Project Workflow で Issue が done へ自動遷移します。
- `mt-create-plan` は廃止しました。計画の新規作成は既存の opencode `mt-create-plan` Skill を使用してください。

## ストレージ

- **計画 SoT:** GitHub Issue + Project(v2)（既存 mt-plan 系と同じ）
- **ステータス:** Project Status custom field（`draft` → `refined` → `in-progress` → `done`）
- **設定:** `~/.config/mt-plan/config.json`（Project ID, Status field ID 等）— 既存と共用
- **実行ログ:** TAKT の `.takt/runs/{slug}/reports/`（詳細レポート）
- **履歴:** GitHub Issue body の `## 🐢 履歴`（サマリ）

## 既存 Skill との関係

| 項目 | 既存 opencode Skill | TAKT ワークフロー |
|------|---------------------|-------------------|
| 入口 | `/mt-run-plan` Slash Command | `takt add #N` → `takt run` |
| 計画 SoT | GitHub Issue + Project | 同左（共用） |
| 状態遷移 | `~/.config/opencode/skills/mt-plan/transition-plan.ts` | `~/.takt/scripts/transition-plan.ts`（コピー） |
| レビュー | SubAgent 5 観点（逐次 dispatch） | parallel step 5 観点（並列） |
| ループ検出 | なし | loop_monitors（supervisor 判定） |
| worktree 実行 | なし（現在のディレクトリ） | `takt add` 時に worktree 指定で isolated 実行 |
| commit/push/PR | Skill 内で手動実施 | TAKT エンジンが自動実行（`auto_pr`） |
| Done 化 | `transition-plan.ts` で手動遷移 | PR-Issue 紐付けで Project Workflow 自動遷移 |
| 設定ファイル | `~/.config/mt-plan/config.json` | 同左（共用） |
| plan-format.md | `~/.config/opencode/skills/mt-plan/plan-format.md` | `~/.takt/facets/knowledge/plan-format.md`（コピー） |

## 初回セットアップ

1. `mt tool install` 経由で `takt` をインストール
2. `mt chezmoi apply` で dot_takt 配下を `~/.takt/` へ展開
3. `~/.config/mt-plan/config.json` が存在しない場合:
   ```bash
   bun ~/.takt/scripts/init-config.ts --owner <owner> --project <number>
   ```
4. `gh auth refresh -s read:project,project` で GitHub Project scope を確保

## スクリプトのテスト

```bash
cd ~/.takt/scripts
bun x vitest run
```
