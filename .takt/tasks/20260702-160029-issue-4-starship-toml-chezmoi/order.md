## Issue #4: starship.toml を chezmoi ソースに配置

## 💭 背景

- `~/.config/starship.toml`（285 行 / 5465 bytes, 最終更新 2026-06-24）は現在 `chezmoi` ソース外で管理されており、ホームディレクトリ消失時に復元不可
- Issue #5（`.zshrc管理検討`）で確立した「個人 dotfiles を `chezmoi/` 配下の Source of Truth に集約する」パターンを `starship` 設定にも適用する
- 機密情報は含まれない（テーマ定義・パレット定義のみ）、テンプレート化は不要
- Issue #3 `Raycast設定コード管理`（OPEN）と同じ「設定管理」シリーズの 1 つ

## ✅ 完了条件

1. `chezmoi/dot_config/starship.toml` がリポジトリ内に存在する
2. 当該ファイルの内容が `~/.config/starship.toml` と byte-for-byte で一致する（`diff -q` で差分なしを確認）
3. 親 `README.md` の chezmoi 章（line 80–99）とトップレベル構成（line 374–380）の両方のツリー図に `dot_config/starship.toml` が追記されている
4. 本 Issue の Status が `done` に遷移している（Project Status custom field 更新 + Issue close）
5. **本計画スコープ外**: `git commit` / `git push` / worktree / `chezmoi apply` / `chezmoi diff` / `mt chezmoi doctor`

## 📦 アウトプット

- `chezmoi/dot_config/starship.toml`（285 行, plain, `~/.config/starship.toml` の完全コピー）
- `README.md`（2 箇所のツリー図更新: line 80–99, line 374–380）
- GitHub Issue #4（Status: `done`）

## 🧭 方針

### 進め方の原則

1. `chezmoi/dot_config/` ディレクトリは既に存在するため、`starship.toml` のみを追加
2. ファイル内容は `~/.config/starship.toml` の完全コピーとし、chezmoi テンプレート化（`.tmpl`）は行わない（変数置換不要）
3. コピー後の検証は `diff -q ~/.config/starship.toml chezmoi/dot_config/starship.toml` で差分なしを確認する
4. README 更新は chezmoi 章（line 80–99）とトップレベル構成（line 374–380）の 2 箇所に `dot_config/starship.toml` を追記する
5. 作業完了後、本 Issue を `done` に遷移する
6. **本計画スコープ外**: `git commit` / `git push` / worktree / `chezmoi apply` 等の後続処理は別 Issue で扱う

### AI 判断範囲・Human Gate

- AI 判断: ファイルコピーコマンドの選択（`cp` / `tee` / chezmoi バイナリ呼び出し）、README 追記位置の微調整、コピー検証コマンドの実行
- Human Gate: 作業完了の目視確認、Issue Done 化の最終承認

## 🐿️ メモ

- 2026-06-30
    - 💭 背景: Issue #5 完了により `chezmoi` Source of Truth パターンが確立済み。本計画は同じパターンの最小スコープ適用で、`chezmoi apply` や commit はスコープ外
    - 🧭 指針: ファイルパスは `chezmoi/dot_config/starship.toml`（chezmoi 規約で `~/.config/starship.toml` に対応）
    - 🧭 指針: コピー後の検証は `diff -q` を採用（Q6 決定）
    - 🤔 論点: `git commit` を本計画スコープに含めるか、別途 worktree plan で実施するかは未確定。後続 plan で扱う
    - 🧭 指針: 実行は `mt-run-plan` 経由で実施（Q8 決定、planning/execution のフェーズ分離）

## 🔍 レビュー

（初期状態、レビュー未実施）

## 🐢 履歴
- 2026-06-30 03:25 [in-progress] refined から遷移
- 2026-06-30 01:53 [refined] draft から遷移

（初期状態、状態遷移は遷移時に自動追記）

### Labels
kind/plan