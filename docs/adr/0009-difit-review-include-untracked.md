---
status: superseded by ADR-0013
---

# ADR-0009: difit レビューで untracked ファイルを含める

- Status: Accepted
- Date: 2026-08-03

## 背景

ワーキングディレクトリのレビューセッションで、untracked ファイルがどちらの層からも漏れていた。

1. **difit ブラウザ表示**: `mt difit start` は `--background` で起動するため、difit の対話プロンプト（untracked を含めるか Y/n）が出ず、untracked はサイレントにスキップされていた。
2. **AI レビュアーの証拠ファイル**: `collect-review-context.ts` は `git diff`（branch diff / unstaged diff）を収集するが、untracked ファイルはどちらにも現れない。実際のレビューセッションで「成果物の新規ファイルが untracked のまま、どちらの証拠にも写っていない」という指摘が起きていた。

## 決定

両層を `git add --intent-to-add`（`git add -N`）機構で統一して修正する。対象は全 untracked ファイル（.gitignore 対象外のみ、`git ls-files --others --exclude-standard` で列挙）。

1. **difit 層**: `mt difit start` が difit サーバ起動前に untracked ファイルへ `git add --intent-to-add` を実行する（`start.rs::mark_untracked_intent_to_add`、best-effort）。
2. **証拠層**: `collect-review-context.ts` が diff 収集前に同じ処理を実行する（`markUntrackedIntentToAdd`）。ワークフローの順序は証拠収集 → difit 起動のため、difit 起動時の処理に頼ると証拠に間に合わない。

intent-to-add エントリはレビュー終了後もクリーンアップしない。ファイルが `git status` / `git diff` に現れ続けることでコミット忘れを防ぐ。git 2.55 は intent-to-add だけのファイルを未ステージとして扱うため、plain `git commit` で空ファイルがコミットされる事故は起きない。

## 代替案

- difit の `--include-untracked` フラグを `translate_difit_args` で自動付与: difit 内部の実装は同じく `git add --intent-to-add` だが、`--background` 起動時に親プロセスが子プロセス stdout の最初の 1 行だけを転送するため、untracked 存在時は JSON ではなく "✅ Files added" メッセージが転送され、`mt difit start` がポート取得で永久ブロックする。採用不可
- 証拠層で `git diff --no-index /dev/null <file>` を追記: index に触れないが、diff ヘッダが変則的でバイナリ判定も自前持ちになる。difit 層とは別の機構が混在する
- 第 3 の証拠ファイル `git-untracked.txt` を新設: レビュアー SubAgent のプロンプト変更も必要で波及が大きい
- `mt difit start --include-untracked` の opt-in フラグ: 付け忘れれば静かに untracked が漏れ、現状の痛点が残る

## 結果・影響

- レビュー対象の untracked ファイルが difit ブラウザ表示と AI レビュアー証拠の両方に自動的に現れる。
- レビュー開始時に index へ intent-to-add が付く（`git status --short` で ` A` 表示）。これは意図的な副作用であり、コミット忘れ防止に寄与する。
- ワークフロー側（workflow.ts）の変更不要。`mt difit start "$BASE_BRANCH"` は自動で恩恵を受ける。
- difit の `--include-untracked` フラグは引き続き使用しない（ハング問題のため）。
