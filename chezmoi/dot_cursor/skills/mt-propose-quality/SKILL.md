---
name: mt-propose-quality
description: 対象 repo のコード品質を分析し、Quality 軸（既存の質の向上）の企画候補を 5〜8 個提示する。重複チェック後にユーザーが選択した候補を draft Issue として起票する。「mt-propose-quality」「品質企画」「品質改善の種まき」などと言われた時に使用する。
---

# mt-propose-quality

対象 repo のコード品質を走査・分析し、Quality 軸（既存の質の向上）の企画候補を厳選して提示する。ユーザーが選択した候補を最小構成の draft Issue として起票する。

企画の具体化（完了条件・方針・実行単位の策定）は `mt-create-plan` の from-Issue フローに委譲する。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `list-plans.ts` — 既存計画 Issue の一覧取得（重複チェックに使用）
- `init-config.ts` — 設定読み込み

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## 🏃 ステップ

### 1. 対象 repo の確認

1. `gh repo view --json nameWithOwner` で対象 repo を確認
2. ユーザーが特定のディレクトリ・モジュールを指定していれば走査範囲を絞る
3. 指定がなければ repo 全体を対象とする

### 2. 品質分析

対象 repo のコードを走査し、以下の観点で品質上の改善機会を収集する:

| 観点 | 走査方法の例 |
|------|-------------|
| 複雑度 | 長大な関数・ファイル、深いネスト、高ファンイン/ファンアウト |
| 浅い module | interface が implementation と同等の複雑さを持つ通過層（詳細は `mt-improve-codebase-architecture` 参照） |
| テスト不足 | テストが存在しない主要モジュール、カバレッジの低い領域 |
| TODO/FIXME | `TODO`・`FIXME`・`HACK`・`XXX` コメントの集積 |
| 依存の古さ | 非推奨 API の使用、古い依存バージョン、セキュリティ警告 |
| ドキュメント陳腐化 | README やコメントが実装と乖離している箇所 |
| エラーハンドリング | 握りつぶし、一貫性のないエラー伝播 |
| 重複コード | 類似ロジックの散在、抽出可能な共通処理 |

走査の優先度:

1. 最近の変更が多い箇所（`git log --oneline -30` で頻出するパス）
2. ユーザーが痛みを言及した領域
3. 上記観点で機械的に検出できる箇所

各観点について、具体的なファイル・行・症状をメモし、企画候補の素材とする。

#### アーキテクチャ深化テーマの扱い

浅い module の深化・大規模なリファクタリングなど、`mt-improve-codebase-architecture` の守備範囲に該当する重いテーマは、企画候補として採用する場合に背景へ以下を注記する:

> 本企画はアーキテクチャ深化を含むため、計画化時に `mt-improve-codebase-architecture` と連携することを推奨する。

### 3. 候補の厳選

収集した素材から、以下の基準で 5〜8 個の企画候補に絞る:

- **自信のあるものだけ残す**。量より質を優先し、下位案で水増ししない
- 各候補は独立した企画として成立する粒度にする
- 同一テーマの細分化は 1 候補にまとめる
- 各候補に以下を付与する:
  - タイトル（簡潔な日本語）
  - 背景（なぜ改善が必要か、走査で得た具体的な根拠）
  - 関連する観点（複雑度、テスト不足など）
  - 推奨度（★1〜5）と理由

### 4. 重複チェック

既存の open Issue・計画と候補を照合し、重複を排除する:

1. `gh issue list --state open --limit 100 --json number,title,labels` で open Issue を取得
2. `bun ~/.config/opencode/skills/mt-plan/list-plans.ts draft refined in-progress` で plans プロジェクト内の計画を取得
3. 各候補について、既存 Issue/計画のタイトル・内容と意味的な重複を判定する:
   - **完全重複**: 候補から除外する
   - **関連あり**: 候補に残し「既存 Issue #N に関連」と注記する
   - **重複なし**: そのまま候補とする

### 5. 候補提示（Human Gate）

ユーザーに候補一覧を提示し、選択を求める:

```
以下の品質改善企画候補を抽出しました。起票したいものを選んでください（複数可）:

1. [★★★★☆] <タイトル> — <背景の要約>
2. [★★★☆☆] <タイトル> — <背景の要約>（既存 Issue #N に関連）
...

番号で選択、または「なし」で終了します。
```

- ユーザーが選択するまで起票しない
- 選択がなければそのまま終了する
- 追加の質問・補足があれば回答してから再提示する

### 6. draft 起票

選択された各候補について、以下の手順で draft Issue を作成する:

#### 6a. label の確認・自動作成

`kind/plan` label が対象 repo に存在しない場合は作成する:

```bash
gh label create "kind/plan" --repo <owner/repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true
```

#### 6b. Issue 作成

本文は **タイトル + 💭 背景のみ** の最小構成とする:

```bash
gh issue create \
  --repo <owner/repo> \
  --title "<企画タイトル>" \
  --label "kind/plan" \
  --body "## 💭 背景

<背景: なぜこの改善が必要か。走査で得た具体的な根拠を書く。>

<アーキテクチャ深化を含む場合は連携注記をここに書く。>

## 🐢 履歴
"
```

#### 6c. Project 追加・Status 設定

`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。

```bash
# Project に追加（itemId を取得）
gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json

# Status を draft に設定
gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>
```

#### 6d. 起票結果の報告

各 Issue について以下を報告する:

- Issue URL
- タイトル
- Status: draft
- 次のステップ: `mt-create-plan` の from-Issue フローで計画化できる旨を案内

### 7. 次ステップ案内

起票完了後、以下を案内する:

> 起票した draft Issue は `mt-create-plan` の from-Issue フローで取り込み、具体的な計画（完了条件・方針・実行単位）に詰められます。

## ✅ 完了条件

- 対象 repo の品質分析が複数観点で実施されている
- 5〜8 個の企画候補が厳選され、ユーザーに提示されている
- 既存 Issue/計画との重複チェックが実施されている
- ユーザーが選択した候補だけが draft Issue として起票されている
- 起票された Issue に `kind/plan` label・plans プロジェクト追加・Status=draft が設定されている
- 起票された Issue の本文がタイトル + 💭 背景の最小構成である

## 📦 アウトプット

- 起票された draft Issue（GitHub URL）
- 候補一覧と選択結果のサマリ

## ⚠️ 注意事項

- 企画の具体化（完了条件・方針・実行単位の策定）はこのスキルの責務ではない。`mt-create-plan` に委譲する
- 候補は 5〜8 個に厳選する。自信のない候補で水増ししない
- ユーザーの選択なしに自動起票しない（Human Gate 必須）
- 重複チェックは毎回実施する。定期実行でノイズが増えないようにする
- アーキテクチャ深化の重いテーマは `mt-improve-codebase-architecture` への連携を背景に注記する
- `~/.config/mt-plan/config.json` が未設定の場合は `mt-plan init` を案内して中断する
- draft Issue の本文に `## ✅ 完了条件` などの計画セクションは含めない（最小構成を維持）
