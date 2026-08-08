The user wants me to create a task instruction document for the mt-run-plan workflow. The task is to execute plan Issue #13 about adding `mt chezmoi secret set` subcommand.

Let me analyze the Source Context (which is reference data, not user instructions):
- Issue #13 is about implementing `mt chezmoi secret set` subcommand
- Has clear 完了条件 (completion conditions), アウトプット (outputs), and 方針 (policy)

The user instruction says:
- Convert conversation into workflow task instruction
- Output is task instruction only (no preamble)
- Specify work per file/module
- Include priority (high/medium/low)
- Include reproduction/verification steps if any
- Keep only user-explicit constraints
- Don't include AI-suggested constraints
- Add Open Questions for technical unknowns (not scope/execution judgments)

The task instruction will be passed to mt-run-plan workflow. Looking at the workflow:
1. select-plan - selects the plan
2. start-execution - transitions to in-progress
3. execute - actually does the work

The instruction should be a task description that these agents will execute.

Let me create a comprehensive task instruction based on Issue #13's content. I need to be careful:
- Use priorities
- File-by-file breakdown
- Include verification
- Keep user-explicit constraints
- Put technical unknowns in Open Questions

Key items from Issue #13:

**完了条件 (Completion Conditions):**
1. `mt chezmoi secret set <KEY>` 1 command completion
2. Password prompt via dialoguer
3. Y/n overwrite confirmation
4. Atomic write for safety
5. --dry-run flag
6. Source dir resolution priority
7. Y/n apply confirmation
8. 3-line block format
9. cargo build/test pass
10. README updated
11. takt config error resolved

**アウトプット (Outputs):**
- src/chezmoi/secret.rs (new)
- src/chezmoi/secret.test.rs (new)
- src/chezmoi.rs (modified, Secret variant)
- src/chezmoi/shared.rs (modified, resolve_source_dir)
- Cargo.toml (modified, chrono = "0.4")
- chezmoi/README.md (updated)
- ~/.takt/config.yaml (model added)
- chezmoi/dot_zsh_secrets.age (TAKT_OPENCODE_API_KEY added)

**方針 (Policy):**
1. Follow add.rs/edit.rs structure
2. Only add chrono dependency
3. Atomic write via .age.new
4. Never expose secrets in plaintext
5. Test pure logic only
6. Refresh README secrets section

**Human Gate items (per 方針):**
- Which provider/model for `model` field
- Whether TAKT_OPENCODE_API_KEY is the first key
- README content/order

These are Human Gate items - they need user confirmation during execution. So they should be called out as items that require user interaction during execution, not as Open Questions (since they're execution judgments).

Wait, the user says:
- "スコープや実行判断に関する問いは含めない" - don't include scope/execution judgment questions in Open Questions
- "技術的な不明点のみ" - only technical unknowns

The Human Gate items are execution judgments, so they should NOT be in Open Questions. But they should be in the task instruction as items requiring user confirmation during execution.

Actually, looking more carefully - the Human Gate items are about confirming with the user during execution. They are part of the work to be done (guide mode). So they should be in the task instruction as items that require user interaction.

Let me also check the AGENTS.md context:
- The tool is `mt` (Rust CLI)
- chezmoi is used for dotfile management
- Source of Truth is in tools/chezmoi/

Let me structure the task instruction:

# Title
# 背景・ゴール
# 作業内容 (by priority)
#   - 高 (High)
#   - 中 (Medium)
#   - 低 (Low)
# 再現手順・確認方法
# 制約
# Open Questions

Let me check the current state of the codebase to understand the context better.

Actually, I should just create the task instruction based on the information provided. The agents in the workflow will explore the codebase as needed.

Let me look at what the user said more carefully:
- "出力はタスク指示書のみ（前置き不要）" - Output is task instruction only, no preamble
- "対象ファイル/モジュールごとに作業内容を明記する" - Specify work per file/module
- "優先度（高/中/低）を付けて整理する" - Organize with priority
- "再現手順や確認方法があれば含める" - Include reproduction/verification if any
- "制約や「やらないこと」は**ユーザーが明示したもののみ**保持する" - Keep only user-explicit constraints
- "制約の出所が不明な場合は保持せず、必要なら Open Questions に回す" - Don't keep unverified constraints
- "アシスタントが提案・推測した制約は指示書に含めない" - Don't include AI-suggested constraints
- "情報不足があれば「Open Questions」セクションを短く付ける（技術的な不明点のみ。スコープや実行判断に関する問いは含めない）" - Add Open Questions for technical unknowns only

Now I need to distinguish what comes from the Issue (which is Source Context) vs what would be user explicit instructions.

The user input is the system prompt itself asking me to convert conversation to task instruction. There's no actual conversation content from the user beyond the Issue content. The Issue content is in Source Context, which is reference data.

Wait, let me re-read. The system prompt says "これまでの会話内容を、ワークフロー実行用の具体的なタスク指示書に変換してください" - convert the conversation so far into a workflow task instruction.

But the "conversation" appears to be just the system prompt + Source Context (Issue #13). There's no actual user message yet other than this.

So I'm converting Issue #13 (the plan) into a task instruction for execution.

The Issue #13 contains:
- 完了条件 (from the user planning)
- アウトプット (from the user planning)
- 方針 (from the user planning)
- メモ (from the user planning)

These are user-explicit content (since the user approved the plan). So they should be in the task instruction.

Let me draft the task instruction:

---

# タスク: Issue #13 mt chezmoi secret set サブコマンド追加

## 概要
`mt chezmoi secret set <KEY>` サブコマンドを実装し、`dot_zsh_secrets.age` への手動 6 ステップ運用を 1 コマンド化する。あわせて `takt` の `model` 設定エラーと OpenCode API キー未設定を解消する。

## 完了条件
Issue #13 の `## ✅ 完了条件` 1〜11 を満たすこと。
1. `mt chezmoi secret set <KEY>` が 1 コマンドで完結する
2. value は `dialoguer` の Password プロンプトで入力される
3. 既存 KEY がある場合は値を出さずに Y/n で上書き確認
4. atomic write により再暗号化失敗時に `.age` ファイルが破損しない
5. `--dry-run` フラグで書き込み内容を事前プレビュー
6. source ディレクトリは `CHEZMOI_SOURCE_DIR` → `chezmoi.toml` の `sourceDir` → `~/src/tools/chezmoi` の順で解決
7. set 実行後に `mt chezmoi apply` を Y/n 確認の上で実行
8. 平文フォーマットは `# <KEY>（<timestamp>）` + 空行 + `export <KEY>=<VALUE>` の 3 行ブロック
9. `cargo build` / `cargo test` が通る
10. `chezmoi/README.md` に `mt chezmoi secret set` の手順が追記されている
11. takt エラーが `model` 追加 + `TAKT_OPENCODE_API_KEY` 設定で解消

## 作業内容

### 優先度: 高（コア機能・ブロッカー）

#### 1. `src/chezmoi/secret.rs`（新規作成）
- `set` サブコマンド本体の実装
- 構造は `src/chezmoi/add.rs` / `edit.rs` に準拠
- 処理フロー:
  - `dialoguer::Password::new().with_prompt(...).interact()` で値入力
  - `~/.config/chezmoi/chezmoi.toml` の `sourceDir` またはデフォルトから `dot_zsh_secrets.age` のパスを解決
  - 既存 KEY があれば grep し、あれば Y/n 確認（値は出さない）
  - なければ新規追加ブロック（3 行）を確認の上で構築
  - 既存 age ファイルを `age -d` バイナリで復号し、平文に新 KEY ブロックを追記
  - 一時ファイル `.age.new` に書き出し → `age -e -r <recipient>` で再暗号化 → 元ファイルを atomic に `mv` で差し替え
  - `--dry-run` フラグ時は書き込み内容（平文ブロックと再暗号化対象ファイル）をプレビュー表示して終了
  - set 完了後に `mt chezmoi apply` を Y/n 確認の上で実行

#### 2. `src/chezmoi.rs`（修正）
- `Secret` バvariant を `Chezmoi` enum に追加
- CLI パーサで `secret set <KEY>` サブコマンドを解釈できるよう配線

#### 3. `src/chezmoi/shared.rs`（修正）
- 既存の `resolve_source_dir()` を `chezmoi.toml` の `sourceDir` 読み取りに対応させる
- 解決優先度: `CHEZMOI_SOURCE_DIR` 環境変数 > `~/.config/chezmoi/chezmoi.toml` の `sourceDir` > デフォルト `~/src/tools/chezmoi`

#### 4. `Cargo.toml`（修正）
- `[dependencies]` に `chrono = "0.4"` を追加（タイムスタンプ生成用）

#### 5. `src/chezmoi/secret.test.rs`（新規作成）
- 純粋ロジックのユニットテスト:
  - KEY 名バリデーション（英大文字 + アンダースコアのみ等）
  - 既存 KEY 検出の grep ロジック
  - パス解決（環境変数 / 設定ファイル / デフォルトの優先度）
- 外部プロセス（age / chezmoi / dialoguer）に依存する統合テストは対象外

### 優先度: 中（ドキュメント・周辺整備）

#### 6. `chezmoi/README.md`（更新）
- 既存の `secrets の追加・更新` 節を刷新し、`mt chezmoi secret set` を推奨手順として前面に出す
- 1 コマンドでの使い方、`--dry-run` の挙動、既存 KEY 上書き確認フローを記載
- 旧 6 ステップ手順は参考として後段に保持（または削除判断はユーザー確認）

### 優先度: 中（ユーザー設定・先行課題）

#### 7. `~/.takt/config.yaml`（更新）
- `model: opencode/<provider>/<model>` を追加
- どの `provider/model` を設定するかは Human Gate（要ユーザー確認）

#### 8. `chezmoi/dot_zsh_secrets.age`（更新）
- `export TAKT_OPENCODE_API_KEY=...` を追加・再暗号化
- 最初の KEY として `TAKT_OPENCODE_API_KEY` で開始して良いかは Human Gate（要ユーザー確認）

## 再現手順・確認方法

### ビルド・テスト
```bash
cargo build
cargo test
```

### 動作確認（手動・ガイドモード）
1. `mt chezmoi secret set --dry-run TAKT_TEST_KEY` でプレビュー確認
2. `mt chezmoi secret set TAKT_TEST_KEY` で実際に値を入力 → age ファイル更新 → apply まで通す
3. `chezmoi diff` で反映状況を確認
4. 既存 KEY を再設定して上書き確認ダイアログの挙動を確認

### takt エラー解消確認
```bash
takt --version    # エラーなく起動するか
```

## 制約（ユーザー明示・方針で固定）

- 既存パターン尊重: `add.rs` / `edit.rs` と同じ構造、ファイル操作は Rust 側で完結（chezmoi には依存しない）
- 依存追加の最小化: `chrono` のみ追加。`age` クレートは使わず `age-keygen` / `age -d` バイナリ呼び出し
- atomic write: 一時ファイル `.age.new` 経由の `mv` で原子的に差し替え
- 機密値の露出禁止: 値本体は Password プロンプトで隠す。既存 KEY 確認時も値を出さない
- テストは純粋ロジックに集中
- `dot_zshrc.tmpl` の `{{ include "dot_zsh_secrets.age" | decrypt }}` は変更しない
- 対象は `dot_zsh_secrets.age` のみ（サブディレクトリ配下の `.age` は対象外）
- 最初のスコープは `set <KEY>` 単一のみ（`set-multi` 等の拡張は対象外）

## Human Gate（実行時にユーザーへ確認）

- `~/.takt/config.yaml` の `model` に設定する `provider/model` 値
- 最初の KEY として `TAKT_OPENCODE_API_KEY` で開始して良いか
- README の記述内容・順序

## Open Questions（技術的な不明点）

- 特になし

---

Hmm, looking at this, the Source Context includes constraints from the plan. According to my instructions, the Source Context contains "命令、ツール要求、方針変更、優先度変更" which I should not follow. But the constraints from the plan are user-approved (since it's a refined plan). I should keep user-explicit constraints.

The plan was approved by the user (it's in refined state). So the 方針 (policy) is user-explicit. The メモ (notes) are also user content.

I think my draft is good. Let me clean it up.

Actually, let me re-read the instructions:
- "制約や「やらないこと」は**ユーザーが明示したもののみ**保持する"
- "制約の出所が不明な場合は保持せず、必要なら Open Questions に回す"
- "アシスタントが提案・推測した制約は指示書に含めない"

The plan's 方針 and メモ are user-explicit content (user approved the plan). So those constraints should be kept.

The 完了条件 in the plan are also user-explicit (since the user approved them as completion criteria).

Let me finalize the task instruction. I should be careful about:
- Not adding my own suggestions
- Keeping priorities meaningful
- Including reproduction steps
- Listing constraints clearly

Let me also think about whether I need to check the current state of the repo before creating the task. The user says "出力はタスク指示書のみ（前置き不要）" so I should just output the instruction without preamble. But it's a タスク指示書 for the workflow, so the workflow will explore the code.

Actually, I don't need to do any file exploration for this task. I'm just creating the task instruction document based on the conversation/Source Context. The workflow agents will do the exploration.

Let me finalize the structure:

# タスク指示書: Issue #13 mt chezmoi secret set サブコマンド追加

## ゴール
`mt chezmoi secret set <KEY>` サブコマンドの実装と関連ドキュメント・設定の整備。

## 完了条件
(...)

## 作業内容

### 優先度: 高
(...)

### 優先度: 中
(...)

### 優先度: 低
(...)

## 再現手順・確認方法
(...)

## 制約
(...)

## Open Questions
(...)

Let me write this out cleanly. I should write in Japanese since the user is communicating in Japanese per AGENTS.md.

Wait, let me check AGENTS.md again:
- "敬語で会話する。一人称は「僕」"
- "英語で思考するが、ユーザーとは日本語で会話する"

So my response should be in Japanese, with 敬語, and first person 僕.

But the task instruction itself - should it be in Japanese or English? The conversation with the user is in Japanese, but the task instruction will be read by the workflow agents. I think the task instruction should be in Japanese to match the user's language and the Issue content.

Let me finalize:
# タスク指示書: Issue #13「mt chezmoi secret set サブコマンド追加」

## ゴール
`mt chezmoi secret set <KEY>` サブコマンドを実装し、`dot_zsh_secrets.age` への手動 6 ステップ運用を 1 コマンド化する。あわせて `takt` の `model` 未設定エラーと OpenCode API キー未設定を解消する。

## 完了条件
Issue #13 の `## ✅ 完了条件` 1〜11 を満たすこと。

1. `mt chezmoi secret set <KEY>` が 1 コマンドで完結する
2. value は `dialoguer` の Password プロンプトで入力され、シェル履歴・プロセスリストに平文が残らない
3. 既存 KEY がある場合は値を出さずに Y/n で上書き確認
4. 再暗号化失敗時に `.age` ファイルが破損しない（atomic write による一時ファイル経由）
5. `--dry-run` フラグで書き込み内容を事前プレビューできる
6. source ディレクトリは `CHEZMOI_SOURCE_DIR` → `~/.config/chezmoi/chezmoi.toml` の `sourceDir` → デフォルト `~/src/tools/chezmoi` の優先度で解決される
7. set 実行後に `mt chezmoi apply` を Y/n 確認の上で実行できる
8. 追加される平文フォーマットは `# <KEY>（<timestamp>）` + 空行 + `export <KEY>=<VALUE>` の 3 行ブロック
9. `cargo build` / `cargo test` が通る
10. `chezmoi/README.md` に `mt chezmoi secret set` の手順が追記されている
11. takt エラーが `~/.takt/config.yaml` の `model` 追加 + `TAKT_OPENCODE_API_KEY` 設定で解消される

## 作業内容

### 優先度: 高（コア機能・ブロッカー）

#### 1. `src/chezmoi/secret.rs`（新規作成）
- `set` サブコマンド本体を実装する
- 構造は `src/chezmoi/add.rs` / `edit.rs` に準拠する
- 処理フロー:
  - `dialoguer::Password::new().with_prompt(...).interact()` で値を入力
  - `resolve_source_dir()` で `dot_zsh_secrets.age` のパスを解決
  - 既存 KEY があれば grep し、存在すれば Y/n 確認（値は絶対に出さない）
  - 既存 age ファイルを `age -d` バイナリで復号し、平文に新 KEY ブロックを追記
  - 一時ファイル `.age.new` に書き出し → `age -e -r <recipient>` で再暗号化 → 元ファイルを atomic に `mv` で差し替え
  - `--dry-run` 指定時は書き込み内容（平文ブロックと再暗号化対象ファイル）をプレビュー表示して終了
  - set 完了後に `mt chezmoi apply` を Y/n 確認の上で実行
- タイムスタンプは `chrono` で生成し、`# <KEY>（<timestamp>）` 行に埋める

#### 2. `src/chezmoi.rs`（修正）
- `Chezmoi` enum に `Secret { command: SecretCommand }` バリアントを追加
- CLI パーサで `secret set <KEY> [--dry-run]` サブコマンドを解釈できるよう配線

#### 3. `src/chezmoi/shared.rs`（修正）
- 既存の `resolve_source_dir()` を `chezmoi.toml` 対応に拡張
- 解決優先度: `CHEZMOI_SOURCE_DIR` 環境変数 > `~/.config/chezmoi/chezmoi.toml` の `sourceDir` > デフォルト `~/src/tools/chezmoi`

#### 4. `Cargo.toml`（修正）
- `[dependencies]` に `chrono = "0.4"` を追加（タイムスタンプ生成用）
- 他の依存追加は方針違反なので行わない

#### 5. `src/chezmoi/secret.test.rs`（新規作成）
- 純粋ロジックのユニットテストのみ:
  - KEY 名バリデーション
  - 既存 KEY 検出の grep ロジック
  - パス解決の優先度（環境変数 / `chezmoi.toml` / デフォルト）
- 外部プロセス（age / chezmoi / dialoguer）に依存する統合テストは対象外

### 優先度: 中（ドキュメント・周辺整備）

#### 6. `chezmoi/README.md`（更新）
- 既存の `secrets の追加・更新` 節を刷新し、`mt chezmoi secret set` を推奨手順として前面に出す
- 1 コマンドでの使い方、`--dry-run` の挙動、既存 KEY 上書き確認フローを記載
- 旧 6 ステップ手順の扱い（参考保持か削除か）は Human Gate として確認

### 優先度: 中（ユーザー設定・先行課題）

#### 7. `chezmoi/dot_zsh_secrets.age`（更新・ガイドモード）
- 実装した `mt chezmoi secret set` を使って `TAKT_OPENCODE_API_KEY` を追加
- 値（API キー）の入力と最終 `apply` 確認はユーザーが手動で行う
- 追加 KEY の確定は Human Gate として確認

#### 8. `~/.takt/config.yaml`（更新・ガイドモード）
- `model: opencode/<provider>/<model>` を追加
- `<provider>/<model>` の具体値は Human Gate として確認

## 再現手順・確認方法

### ビルド・テスト
```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
```

### 動作確認（ガイドモードでユーザーと実施）
1. `mt chezmoi secret set --dry-run TAKT_TEST_KEY` でプレビュー内容を確認
2. `mt chezmoi secret set TAKT_TEST_KEY` で値を入力 → age ファイル更新 → `apply` まで通す
3. `chezmoi diff` で反映状況を確認
4. 既存 KEY を再設定し、上書き確認ダイアログの挙動を確認
5. `takt --version` などで takt エラーが解消されたか確認

### 単体テスト
```bash
cargo test --lib chezmoi::secret
```

## 制約（ユーザー明示・方針固定）

- 既存パターン尊重: `add.rs` / `edit.rs` と同じ構造を踏襲。ファイル操作は Rust 側で完結し、chezmoi バイナリには依存しない
- 依存追加の最小化: `chrono` のみ追加。`age` クレートは使わず `age-keygen` / `age -d` バイナリ呼び出しで十分
- atomic write: 一時ファイル `.age.new` 経由で `mv` し、中途半端な状態を残さない
- 機密値の露出禁止: 値本体は Password プロンプトで隠す。既存 KEY 確認時も値を出さない
- テストは純粋ロジックに集中
- 既存の `dot_zshrc.tmpl` の `{{ include "dot_zsh_secrets.age" | decrypt }}` は変更しない
- 対象は `dot_zsh_secrets.age` のみ（サブディレクトリ配下の `.age` は対象外）
- 最初のスコープは `set <KEY>` 単一のみ（`set-multi` 等の拡張は対象外）

## Open Questions

なし