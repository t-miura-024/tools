---
status: superseded by ADR-0013; re-adopted by ADR-0026
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

## 再採用範囲（ADR-0026）

ADR-0026 は「レビュー対象の untracked ファイルを difit 表示と検証証拠の両方に含める」という目的を再採用するが、実装は旧決定（両層を `git add --intent-to-add` で統一）から変更した。

- **difit 層**: `mt difit start` が difit 公式の `--include-untracked` を全ターゲットの共通フラグとして付与する。untracked の列挙と `git add --intent-to-add` は difit 自身が起動時に行う（target が working / `.` の起動に限る。mt の `--background` 起動ではバックグラウンド子プロセスが実行する）。mt 側の intent-to-add 再実装（`start.rs::mark_untracked_intent_to_add`）は削除された。
- **証拠層**: mt-review-diff の `collect_context` は `git ls-files --others --exclude-standard` で列挙した untracked を `git diff --no-index /dev/null <file>` で diff.txt へ追記する（index には触れない）。旧「代替案」が難点としたヘッダの変則性・バイナリの自前判定は、`diffContainsUntrackedFile` が `diff --git` / `+++` 行の候補一致で存在だけを判定する方式（バイナリ・空ファイルでも見出し行は出る）で吸収する。target ありの収集では untracked を含めない（範囲の契約は ADR-0026「検証対象 diff.txt の提示範囲と完全性（target あり / なし）」を参照）。

### ハング前提の撤回

本文「代替案」が `--include-untracked` を「採用不可」とした根拠（`--background` 起動時に親プロセスが子プロセスの非 JSON 行（"✅ Files added" 等）を転送し、`mt difit start` がポート取得で永久ブロックする）は、実 difit 5.0.12 の検証で成立しないことを確認した。バックグラウンド親は子プロセスを stdout `ignore` で起動し、IPC ハンドシェイクの JSON 1 行だけを自身の stdout へ出力する（子の "✅ Files added" は転送されない）。`mt difit start` は期限付きで `{` 始まりの JSON 行を読むため、untracked が存在してもハングせず起動できる（契約は start.test.rs の実 difit E2E で固定する）。

### `git commit -a` リスク評価

`--include-untracked` は difit 自身が `git add --intent-to-add` を実行するため、レビュー開始時に untracked が index へ載る（`git status --short` で ` A` 表示）。

- plain `git commit` は intent-to-add だけのファイルをコミットしない（git 2.55 で確認。intent-to-add 以外の変更がない場合は「no changes added to commit」で commit されない。空ファイルがコミットされる事故は起きない）。
- 一方、`git commit -a` は intent-to-add エントリを内容ごと巻き込む（git 2.55 で確認）。レビュー中に手動で `git commit -a` すると、未コミットの untracked 成果物が意図せずコミットに含まれ得る。
- 取り消しは difit の案内（`git reset -- <files>`）に依存する（mt は後始末しない）。`--background` 起動では difit の案内メッセージが daemon 側の stdout（`ignore`）へ出て表示されないため、`git status --short` の ` A` 表示が目視の手掛かりになる。
