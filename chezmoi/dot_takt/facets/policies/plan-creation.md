# Plan Creation Policy

計画 Issue 作成時に遵守すべきルールを定義する。

## Issue 作成の基本ルール

- 計画は日本語で書く。
- Issue body は knowledge/plan-format.md に定義されたフォーマットに従う。
- Issue title に計画タイトルを書く。body には `# 計画タイトル` を含めない（重複を避ける）。
- `## 💭 背景`、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🔍 レビュー`、`## 🐢 履歴` は必須セクション。
- セクション間で同じ内容を重複させない。各セクションは責務に閉じて書く。

## 対象 repo の決定

- `gh repo view --json nameWithOwner` で現在ディレクトリの repo を確認する。
- repo の owner が `t-miura-024` → その repo をそのまま使用。
- それ以外 → `t-miura-024/note` を対象 repo とし、`external/[repo-name]` label を付与。

## label の確認・自動作成

- 対象 repo に `kind/plan` label が存在するか確認し、存在しない場合は自動作成する。
- `external/[repo-name]` label が必要な場合も同様に確認・自動作成する。
- label の自動作成は冪等（既存ならスキップ、なければ作成）。

## from-Issue フロー

- `{task}` に既存 Issue の内容が含まれる場合（`takt #N` で起動した場合）は from-Issue フローとして扱う。
- 既存 Issue の body は「参考: 既存 Issue #<n> の body はこんな内容です」と表示する（Grill Phase の pre-fill には使用しない）。
- 既に `kind/plan` label を持つ場合は「この Issue は既に plan です。上書き / 中止？」と確認する。
- from-Issue フローの場合は、既存 Issue を変更する前に変更プレビューを表示し、ユーザー確認を得る。
- 既存 Issue のメモ・履歴を消す前にユーザーに警告する。

## Project 追加・Status 設定

- `gh issue create` の `--project` フラグで Project 追加と同時にドラフト的に登録する。
- `~/.config/mt-plan/config.json` の `projectNumber` を使って `--project "<number>"` で指定する。
- Status は `draft` に設定する（`config.json` の `statusOptions.draft` から optionId を取得）。

## 状態遷移

- 状態遷移は `~/.takt/scripts/transition-plan.ts` を使い、`gh project item-edit` 等の直接呼び出しをしない。
- `draft` から `refined` への昇格は、ユーザーが明示的に承認した場合のみ行う。
- `~/.config/mt-plan/config.json` が存在しない場合は、`init-config.ts` の実行を案内して中断する。
