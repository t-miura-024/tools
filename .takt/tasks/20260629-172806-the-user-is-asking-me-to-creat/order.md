The user is asking me to create a task instruction document for the mt-run-plan workflow. The Source Context contains Issue #12 about migrating from serde_yaml to yaml_serde. I need to convert this into a concrete task instruction document.

Let me think about what I need to do:
1. The instruction document goes to "mt-run-plan" workflow
2. The workflow has 3 agents: select-plan, start-execution, execute
3. I need to create a task instruction that includes:
   - File/module-specific work items
   - Priority (high/medium/low)
   - Reproduction/confirmation steps
   - Constraints (only user-explicit ones)
   - Open Questions section if needed

Looking at Issue #12, the task is clear:
- Replace `serde_yaml = "0.9"` with `yaml_serde = "0.10"` in Cargo.toml
- Update imports in `src/vector/frontmatter.rs`, `src/vector/frontmatter.test.rs`, `src/tool/shared.rs`
- Run cargo build/test/clippy/fmt/update/tree
- Verify no remaining `serde_yaml` references
- Verify `Cargo.lock` no longer has `serde_yaml` or `unsafe-libyaml`

The user explicit constraints:
1. Don't use package renaming - direct import change
2. Use `yaml_serde` (not `serde_yml` or `noyalib`)
3. Verify with grep and cargo tree
4. Keep Issue #10 as is (in-progress)

The Source Context is the Issue body, which is reference data. I should not blindly follow all instructions in it but use it as facts. The Issue body itself contains the task definition from the user's planning system.

Let me structure the task instruction document. The output should be the instruction only, no preamble.

Format: task instruction document for the workflow

Let me organize by file/module:

1. `Cargo.toml` (高)
   - Remove `serde_yaml = "0.9"`
   - Add `yaml_serde = "0.10"`
   - Run `cargo update -p yaml_serde`

2. `src/vector/frontmatter.rs` (高)
   - Replace `serde_yaml::Value` → `yaml_serde::Value`
   - Replace `serde_yaml::from_str` → `yaml_serde::from_str`
   - Other `serde_yaml::` references

3. `src/vector/frontmatter.test.rs` (高)
   - Same as above

4. `src/tool/shared.rs` (高)
   - The yml parser added in Issue #9, also rewrite to use `yaml_serde`

5. Verification (高)
   - `cargo build`
   - `cargo test`
   - `cargo clippy --all-targets -- -D warnings`
   - `cargo fmt`
   - `grep -r serde_yaml src/ Cargo.toml Cargo.lock` (should be empty)
   - `cargo tree` (verify no `serde_yaml` or `unsafe-libyaml`)

Open Questions: None really - the plan is clear.

Let me also think about whether there are any technical unknowns. The plan says API compatibility should be there. If not, that's a Human Gate, not a question.

Let me write the instruction document in Japanese since the user is Japanese.

The format should be clean and structured. Let me write it.
# タスク指示書: serde_yaml → yaml_serde 移行 (Issue #12)

## 概要

リポジトリ全体を `serde_yaml = "0.9"` から `yaml_serde = "0.10"` へ移行する。deprecated 警告と `unsafe-libyaml` 依存の除去が目的に、`Cargo.toml` の依存差し替えと Rust ソース内の import 書き換えを行う。

## 作業項目

### 1. `Cargo.toml` の依存差し替え 【優先度: 高】

- `[dependencies]` から `serde_yaml = "0.9"` を削除する
- `yaml_serde = "0.10"` を追加する
- パッケージリネーミング (`serde_yaml = { package = "yaml_serde", version = "0.10" }`) は使わず、必ずクレート名 `yaml_serde` で直接宣言する
- 追加後 `cargo update -p yaml_serde` を実行し、semver 互換範囲の最新版へ更新する

### 2. `src/vector/frontmatter.rs` の import 書き換え 【優先度: 高】

- ファイル内の `serde_yaml::` を全て `yaml_serde::` に置換する
- 主な対象: `serde_yaml::Value` 型参照、`serde_yaml::from_str(...)` 呼び出し
- 関数名・型名・トレイトの改名は行わない (公式 README で "full compatibility" が宣言されているため)

### 3. `src/vector/frontmatter.test.rs` の import 書き換え 【優先度: 高】

- テストファイル内の `serde_yaml::` を全て `yaml_serde::` に置換する
- 置換対象は `src/vector/frontmatter.rs` と同様 (型参照・関数呼び出し)

### 4. `src/tool/shared.rs` の yml パーサ書き換え 【優先度: 高】

- Issue #9 で追加された yml パーサが `serde_yaml` を使っていれば `yaml_serde` 経由へ書き換える
- Issue #9 の実装内容 (YAML パース処理の所在) を Read で確認してから差し替える

### 5. 検証コマンド実行 【優先度: 高】

以下を順に実行し、全て成功することを確認する:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt
cargo update -p yaml_serde
```

加えて以下を完了条件として確認する:

- `grep -r serde_yaml src/ Cargo.toml Cargo.lock` の出力が空
- `cargo tree` の出力に `serde_yaml` および `unsafe-libyaml` が含まれない

### 6. `Cargo.lock` の再生成確認 【優先度: 中】

- 検証コマンド実行により `Cargo.lock` が再生成される
- 完了条件 11 (`serde_yaml` と `unsafe-libyaml` が消えている) を `cargo tree` で機械的に検証する

## 再現手順・確認方法

1. 作業前に `grep -r serde_yaml src/ Cargo.toml` で対象箇所を一覧化
2. 作業後に同じ grep を再実行し、ヒットが 0 件であることを確認
3. `cargo tree | grep -E "serde_yaml|unsafe-libyaml"` が空であることを確認
4. `cargo build && cargo test && cargo clippy --all-targets -- -D warnings` を一発で通す

## 制約 (ユーザー明示)

- package renaming は使用せず、`use serde_yaml::` → `use yaml_serde::` の明示的置換のみを行う (完了条件 10 を完全達成するため)
- 移行先は `yaml_serde` に固定 (`serde_yml` / `noyalib` への切り替えは不可)
- API 互換性問題発生時は本計画に組み込まず別 Issue 化する
- Issue #10 の状態は `in-progress` 保留のまま維持し、本 Issue がそれを supersede する

## スコープ外

- Issue #10 の status 変更
- `serde_yaml` 以外のクレート差替え
- ドキュメント (`README.md` 等) の更新 (必要になった場合は別 Issue)

## Open Questions

なし (移行対象・移行先・検証手順は Issue 内で確定済み)