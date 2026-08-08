The user wants me to create a task instruction document for the mt-run-plan workflow. The task is based on Issue #4 which is about placing `starship.toml` into the chezmoi source.

Let me analyze the source context carefully:

1. The task is from Issue #4: Place `starship.toml` into chezmoi source
2. The plan is in `refined` status (2026-06-30 01:53)
3. The completion conditions are clear
4. The scope explicitly excludes: git commit/push, worktree, chezmoi apply/diff, mt chezmoi doctor

The instruction document should:
- Be a task instruction only (no preamble)
- Specify work content per file/module
- Include priority (high/medium/low)
- Include reproduction/confirmation steps
- Keep only user-explicitly-stated constraints
- Use Open Questions section for technical unknowns (not scope/execution decisions)

Looking at the workflow:
1. select-plan: Select the plan (Issue #4 is specified)
2. start-execution: Transition to in-progress
3. execute: Execute the work

The execute step is the main work. The task instructions should be focused on this.

Let me create a clean task instruction document. The Source Context says the Issue is #4 specifically, so the select-plan step will use issue #4.

Key work items from the plan:
1. Copy `~/.config/starship.toml` to `chezmoi/dot_config/starship.toml`
2. Verify byte-for-byte match using `diff -q`
3. Update README.md at two locations (line 80-99 and line 374-380) to include `dot_config/starship.toml` in tree diagrams
4. Transition Issue #4 to `done` status

Explicit constraints (user-stated):
- Do NOT include: git commit, git push, worktree, chezmoi apply, chezmoi diff, mt chezmoi doctor
- File should NOT be templated (.tmpl not needed)
- No sensitive information handling needed

Let me write this out as a clean task instruction document.
# タスク指示書: Issue #4 starship.toml を chezmoi ソースに配置

## 対象計画

- Issue: #4 「starship.toml を chezmoi ソースに配置」
- 現在ステータス: `refined` (2026-06-30 01:53)
- 実行モード: 直接実行モード

## 完了条件

1. `chezmoi/dot_config/starship.toml` がリポジトリ内に存在する
2. 当該ファイルが `~/.config/starship.toml` と byte-for-byte で一致する（`diff -q` で差分なし）
3. `README.md` の chezmoi 章（line 80–99）とトップレベル構成（line 374–380）の両ツリー図に `dot_config/starship.toml` が追記されている
4. GitHub Issue #4 の Status custom field が `done` に更新され、Issue が close されている
5. `## 🐢 履歴` に本実行のサマリが追記されている

## 作業内容

### 優先度: 高

#### 1. ファイルコピー（中）

- コピー元: `~/.config/starship.toml`（285 行 / 5465 bytes）
- コピー先: `chezmoi/dot_config/starship.toml`
- コピー手段: `cp ~/.config/starship.toml chezmoi/dot_config/starship.toml`（plain コピー、`.tmpl` 化しない）
- 検証: `diff -q ~/.config/starship.toml chezmoi/dot_config/starship.toml` で差分なしを確認

#### 2. README.md 更新（高）

- 対象 1: chezmoi 章（line 80–99）のツリー図に `dot_config/starship.toml` を追記
- 対象 2: トップレベル構成（line 374–380）のツリー図に `dot_config/starship.toml` を追記
- 追記位置は方針通り line 80–99 と line 374–380 のツリー図内とする
- 微調整（行番号のずれ等）は AI 判断で吸収可

#### 3. GitHub Issue #4 遷移（高）

- Project Status custom field を `done` に更新
- Issue を close
- `## 🐢 履歴` に実行サマリ（コピー完了・README 更新・検証結果）を 1–3 行で追記

### 優先度: 低

- なし

## 確認手順

```bash
# 1. ファイル存在確認
ls -la chezmoi/dot_config/starship.toml

# 2. byte-for-byte 一致確認
diff -q ~/.config/starship.toml chezmoi/dot_config/starship.toml
# 期待出力: （差分なしの旨。差分ありならファイル名が出る）

# 3. 行数一致確認
wc -l ~/.config/starship.toml chezmoi/dot_config/starship.toml

# 4. README 追記確認
grep -n "dot_config/starship.toml" README.md
# 期待: chezmoi 章内とトップレベル構成内の 2 箇所でヒット

# 5. Issue 状態確認
gh issue view 4 --json state,projectItems
```

## スコープ外（明示的に実施しない）

- `git commit` / `git push` の実行
- worktree の作成・操作
- `chezmoi apply` / `chezmoi diff` の実行
- `mt chezmoi doctor` の実行
- ファイル内容の改変・テンプレート化（`.tmpl` 化）
- 機密情報の取り扱い処理（不要）

## Open Questions

- なし