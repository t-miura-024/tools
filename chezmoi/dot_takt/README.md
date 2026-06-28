# dot_takt — TAKT ワークフロー設定（mt-plan 横展開）

既存の opencode mt-plan 系 Skill（`mt-plan`、`mt-create-plan`、`mt-run-plan`）の振る舞いを TAKT ワークフローとして横展開した資材セット。

## 目的

mt-plan 系 Skill の「Grill Phase → 計画作成 → 実行 → 並列レビュー → Done」というライフサイクルを TAKT の宣言的ワークフローで実現する。既存 Skill は削除せず並存（横展開）であり、将来的な TAKT 集約または破棄の両方向に対応できるよう、TAKT 側に独立した資材セットを持つ。

## ディレクトリ構成

```
~/.takt/                       (dot_takt/ から chezmoi apply で展開)
├── config.yaml                # TAKT 本体設定 + workflow_categories
├── workflows/
│   ├── mt-create-plan.yaml    # 計画作成ワークフロー
│   └── mt-run-plan.yaml       # 計画実行ワークフロー
├── facets/
│   ├── personas/              # WHO — ロール定義
│   │   ├── grill-partner.md
│   │   ├── executor.md
│   │   ├── reviewer-essence.md
│   │   ├── reviewer-completeness.md
│   │   ├── reviewer-scope.md
│   │   ├── reviewer-policy.md
│   │   ├── reviewer-quality.md
│   │   └── supervisor.md
│   ├── policies/              # RULES — ルール・品質基準
│   │   ├── grill.md
│   │   ├── plan-creation.md
│   │   ├── execution.md
│   │   └── review.md
│   ├── instructions/          # WHAT — 手順
│   │   ├── grill.md
│   │   ├── create-issue.md
│   │   ├── human-gate-create.md
│   │   ├── promote-refined.md
│   │   ├── select-plan.md
│   │   ├── start-execution.md
│   │   ├── execute.md
│   │   ├── review-essence.md
│   │   ├── review-completeness.md
│   │   ├── review-scope.md
│   │   ├── review-policy.md
│   │   ├── review-quality.md
│   │   ├── fix.md
│   │   ├── done-gate.md
│   │   ├── promote-done.md
│   │   └── update-history.md
│   ├── knowledge/             # CONTEXT — 参照資料
│   │   └── plan-format.md
│   └── output-contracts/      # OUTPUT — 出力フォーマット
│       ├── plan.md
│       ├── review-verdict.md
│       └── execution-report.md
└── scripts/                   # 状態遷移スクリプト（既存より二重管理）
    ├── transition-plan.ts
    ├── list-plans.ts
    ├── init-config.ts
    ├── init-config-gh.ts
    ├── *.test.ts
    ├── package.json
    └── bun.lock
```

## ワークフロー

### mt-create-plan（計画作成）

```
grill (ループ, requires_user_input)
  → create-issue (GitHub Issue 作成, Status=draft)
  → human-gate (refined 昇格の確認, requires_user_input)
  → promote-refined (transition-plan.ts で refined へ)
  → run-plan (workflow_call で mt-run-plan を呼ぶ)
  または
  → promote-refined-end (refined へ昇格して終了)
  または
  → COMPLETE (draft のまま残す)
```

Grill Phase は step ループで実現し、3 選択肢 + 5 つ星 + 1 問 1 答 + 「十分」まで継続する振る舞いを persona/policy/instruction facet で完全制御する。

### mt-run-plan（計画実行）

```
select-plan (list-plans.ts で一覧, requires_user_input)
  → start-execution (transition-plan.ts で in-progress へ)
  → execute (方針ベース実行, edit: true, requires_user_input)
  → reviewers (5 観点の並列レビュー, edit: false)
      ├─ essence (本質性・効率性)
      ├─ completeness (完了条件の充足)
      ├─ scope (スコープ遵守)
      ├─ policy (方針との整合)
      └─ quality (アウトプット品質)
  → fix (any("needs_fix") の場合, 修正実行)
  → done-gate (all("approved") の場合, ユーザー確認, requires_user_input)
  → promote-done (transition-plan.ts で done へ)

loop_monitors:
  cycle: [execute, reviewers, fix]
  threshold: 3
  judge: supervisor (進捗判定, 無限ループ防止)
```

## 起動方法

```bash
# 新規計画作成から実行まで（Grill → Issue 作成 → Human Gate → 実行）
takt --workflow mt-create-plan
# または takt を起動してワークフロー選択 UI から "MT Plan" カテゴリの mt-create-plan を選ぶ

# from-Issue フロー（既存 Issue を plan 化）
takt #28 --workflow mt-create-plan

# 既存計画の実行のみ
takt #N --workflow mt-run-plan
# または takt --workflow mt-run-plan で一覧から選択
```

## ストレージ

- **計画 SoT:** GitHub Issue + Project(v2)（既存 mt-plan 系と同じ）
- **ステータス:** Project Status custom field（`draft` → `refined` → `in-progress` → `done`）
- **設定:** `~/.config/mt-plan/config.json`（Project ID, Status field ID 等）— 既存と共用
- **実行ログ:** TAKT の `.takt/runs/{slug}/reports/`（詳細レポート）
- **履歴:** GitHub Issue body の `## 🐢 履歴`（サマリ）

## 既存 Skill との関係

| 項目 | 既存 opencode Skill | TAKT ワークフロー |
|------|---------------------|-------------------|
| 入口 | `/mt-plan` Slash Command | `takt --workflow mt-create-plan` |
| Grill Phase | SKILL.md の指示 | persona/policy/instruction facet |
| 計画 SoT | GitHub Issue + Project | 同左（共用） |
| 状態遷移 | `~/.config/opencode/skills/mt-plan/transition-plan.ts` | `~/.takt/scripts/transition-plan.ts`（コピー） |
| レビュー | SubAgent 5 観点（逐次 dispatch） | parallel step 5 観点（並列） |
| ループ検出 | なし | loop_monitors（supervisor 判定） |
| worktree 実行 | なし（現在のディレクトリ） | run のみ worktree あり（isolated） |
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
