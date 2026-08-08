The user is asking me to create a task instruction document for the mt-run-plan workflow. Let me analyze the Source Context (Issue #3: Raycast設定コード管理) and convert it into a concrete, executable task instruction.

Key points from the Issue:
1. **Goal**: Manage Raycast settings in Git via `mt raycast sync` and `mt raycast restore` commands
2. **Architecture**: Mirror `src/chezmoi/` structure with new `src/raycast/` module
3. **Encryption**: Use existing `.age` encryption pattern (like `dot_zsh_secrets.age`)
4. **Source of Truth**: Raycast actual config, not chezmoi source
5. **Raycast Export**: v1.22.0+ Export Settings & Data with passphrase (8+ chars)
6. **Files to create**:
   - `src/raycast/` module (sync.rs, restore.rs, shared.rs, shared.test.rs, etc.)
   - `chezmoi/dot_Raycast.rayconfig`
   - `chezmoi/dot_raycast_passphrase.age`
   - README updates

Open Questions to identify (technical unknowns only):
- passphrase file final naming (Q14 pending) - but actually this is a naming decision, the Issue says "Q14 で最終命名確定" - this is a user decision
- restore passphrase UX (CLI prompt vs env var vs cache)
- partial category exclusion (since Export is bulk)
- commit message format

The instructions say to NOT include scope/execution judgment questions, only technical unknowns. The naming question and UX are user decisions, but they need to be resolved before implementation can complete. I'll keep them as Open Questions since they affect concrete implementation.

Wait, re-reading: "「実装するかどうか」「どこまでやるか」のようなスコープ判断はOpen Questionsに含めない" - the question of "どこまでやるか" is excluded. The naming and UX are more like implementation details that need user input, not scope. I'll list them as technical questions that block implementation.

Let me structure the task instruction. The mt-run-plan workflow is for executing a refined plan. The Issue is in `refined` status. The workflow will:
1. select-plan → Issue #3
2. start-execution → transition to in-progress
3. execute → do the work
4. (likely review steps after)

The output should be a task instruction document. Let me write it in Japanese (per AGENTS.md) but the instruction format should be clear for AI agents.

I should focus on the actual implementation tasks. Let me organize by module/file with priority.

Looking at the existing `src/chezmoi/` structure - I should investigate this first... but the user wants me to create the task instruction. The instruction can be created without knowing the exact current structure; the workflow agents will read it.

Actually, let me check if I have access to the source. The working directory is /Users/mt/src/tools. I should at least look at the existing structure to write better instructions. But the AGENTS.md says be concise. Let me create the instruction document first based on the Issue content.

Wait - I should check the existing `src/chezmoi/` structure to give better module-level instructions. Let me do that quickly.
Good, I can see the structure. Let me check the existing chezmoi module to understand the pattern. Let me also look at how `chezmoi.rs` (the entry point) works to understand the pattern for adding a new subcommand.
Now I have a clear picture. Let me also check the existing age-related logic and how `dot_zsh_secrets.age` is referenced.
Good. Now I have a clear picture. The `age` decryption is not handled by mt code itself - the existing pattern uses `dot_zsh_secrets.age` which is decrypted by zsh with `age` CLI. Let me check how that's used.
Now I have all the context I need. The age pattern is:
- The encrypted file `dot_zsh_secrets.age` is decrypted via chezmoi's `{{ include ... | decrypt }}` template directive
- This is handled by chezmoi, not by mt directly
- The `mt` tool doesn't handle age decryption itself

For Raycast, the same pattern can be followed:
- Store passphrase in `chezmoi/dot_raycast_passphrase.age` (encrypted with age)
- Restore would use `age -d` to decrypt the passphrase file (via the `mt` binary or via chezmoi template mechanism)

But wait - `age -d` requires the private key. The existing pattern uses chezmoi's decrypt feature. For mt-run, the workflow could:
1. Decrypt via `age -d -i ~/.config/age/keys.txt chezmoi/dot_raycast_passphrase.age` 
2. Or use chezmoi template to render the plaintext temporarily

The Issue says "既存 `dot_zsh_secrets.age` と同じ `.age` 暗号化ファイルで管理し、`mt` 実行時に復号化して Raycast 暗号化フローに渡す" - so the decryption happens at `mt` runtime.

Now let me write the task instruction. The workflow expects:
- Output: only the task instruction (no preamble)
- Organized by file/module with priorities
- Include reproduction steps
- Include Open Questions for technical unknowns only

The issue has 3 open論点 (questions) that affect implementation:
1. passphrase file final naming (user decision, but blocks implementation)
2. restore passphrase UX (user decision, but blocks implementation)
3. partial category exclusion approach (technical decision)

For #1 and #2, the Issue says "Q14 で最終命名確定" and these are in the 🐿️ メモ as 🤔 論点. The instructions say "実装するかどうか」「どこまでやるか」のようなスコープ判断はOpen Questionsに含めない" - so I need to think:
- Naming and UX are user decisions, not scope decisions
- But the user hasn't told me what to decide in the current message
- I should list them as Open Questions to be resolved before/during execution

Actually re-reading: "情報不足があれば「Open Questions」セクションを短く付ける（技術的な不明点のみ。スコープや実行判断に関する問いは含めない）"

These are user decisions required for implementation, not technical unknowns. Hmm. But without these decisions, the implementation cannot proceed. The instruction executor would face:
- "what should I name the file?" - user must answer
- "what UX?" - user must answer

I think these are valid Open Questions because they're blocking technical decisions that need user input, not scope judgment. The "どこまでやるか" exclusion seems to mean questions like "should I even implement this feature?" - not "what should the name be?".

Let me draft the task instruction now.

Structure:
1. Goal summary (brief)
2. Implementation tasks by file/module with priority
3. Reproduction / verification steps
4. Open Questions

Let me make this concrete and actionable.

Key tasks:
- High priority:
  - Create `src/raycast.rs` (entry point with Subcommand enum, run function) - mirror `src/chezmoi.rs`
  - Create `src/raycast/` module dir with `sync.rs`, `restore.rs`, `shared.rs`, `shared.test.rs`
  - Wire up in `src/main.rs` (add `mod raycast;`, add `Raycast(RaycastCommands)` variant)
  - Implement `sync.rs`: invoke Raycast export, place file, git commit & push
  - Implement `restore.rs`: pull from git, decrypt passphrase, invoke Raycast import
  - Implement `shared.rs`: path resolution, age decryption helper, chezmoi path constant
  - Create `chezmoi/dot_Raycast.rayconfig` (initially empty or sample)
  - Create `chezmoi/dot_raycast_passphrase.age` (placeholder encrypted with age pubkey)
  - Update README

- Medium priority:
  - Tests for shared.rs
  - Doctor command for raycast (binary check, age key check, etc.) - actually the Issue says mirror structure; let me check what chezmoi has
  
Wait, the chezmoi module has: add, apply, diff, doctor, edit, init, install_hook, shared, status, uninstall_hook. The Issue only requires sync and restore. So I should only do those two plus shared.

Let me reconsider: the Issue says "src/raycast/ モジュール（既存 src/chezmoi/ と同構造: sync.rs, restore.rs, shared.rs, shared.test.rs 等）" - this is non-exhaustive ("等") and only specifies the minimum required.

The completion conditions only require:
1. `mt raycast sync` works
2. `mt raycast restore` works
3. Version management
4. Passphrase in .age
5. Mirror structure
6. All 11 categories in one file

So minimum: sync.rs, restore.rs, shared.rs (+ test). 

Let me write the task instruction now. I'll keep it focused and clear.

Verification steps:
- `cargo build` succeeds
- `cargo test` passes
- `mt raycast --help` shows subcommands
- `mt raycast sync` actually runs through (or at least dry-run)
- `mt raycast restore` actually runs

Open Questions:
- Q1: passphrase file final naming
- Q2: restore passphrase UX
- Q3: partial category exclusion

Let me write it.
```markdown
# タスク指示書: Raycast 設定コード管理（Issue #3）

## 🎯 ゴール

Raycast の全 11 カテゴリ設定を Git でバージョン管理し、`mt raycast sync` / `mt raycast restore` の 2 サブコマンドで往復運用できるようにする。Raycast 実体（`~/Library/Application Support/com.raycast.macos/`）を Source of Truth とし、chezmoi ソースは暗号化済みバックアップキャッシュとして扱う。

---

## 📋 実装タスク（優先度順）

### 【高 1】`src/raycast.rs` 新設（エントリポイント）

`src/chezmoi.rs` と同構造の `Subcommand` enum と `run` 関数を実装する。

- `pub mod shared;` `pub mod sync;` `pub mod restore;` を公開
- `pub enum RaycastCommands { Sync, Restore }`（`#[derive(Subcommand)]`）
- `pub fn run(cmd: RaycastCommands) -> anyhow::Result<()>` で分岐
- 参考: `src/chezmoi.rs:1-48`

### 【高 2】`src/raycast/shared.rs` 新設（共通ユーティリティ）

- パス解決ヘルパー:
  - `pub fn chezmoi_source_dir() -> PathBuf`（`CHEZMOI_SOURCE_DIR` 環境変数 → 既定 `~/src/tools/chezmoi`）
  - `pub fn raycast_data_dir() -> PathBuf`（`~/Library/Application Support/com.raycast.macos/`）
  - `pub fn rayconfig_path() -> PathBuf`（`chezmoi_source_dir() / "dot_Raycast.rayconfig"`）
  - `pub fn passphrase_age_path() -> PathBuf`（`chezmoi_source_dir() / "dot_raycast_passphrase.age"`）
- 暗号化復号:
  - `pub fn decrypt_passphrase() -> anyhow::Result<String>` — `age -d -i ~/.config/age/keys.txt <passphrase_age_path>` を実行し、stdout から plaintext passphrase を取得
- バイナリ存在チェック:
  - `pub fn raycast_cli_present() -> bool`（`raycast --version` 確認）
  - `pub fn age_binary_present() -> bool`（`age --version` 確認）
- `pub fn resolve_source_dir()` ロジックは `src/chezmoi/shared.rs:15-30` をそのまま流用可
- `ENV_LOCK` ミューテックス + `#[path = "shared.test.rs"]` 参照も `src/chezmoi/shared.rs:77-86` を踏襲

### 【高 3】`src/raycast/sync.rs` 新設

`pub fn run(_args: &[&str]) -> anyhow::Result<()>` を実装。手順:

1. 前提チェック: `raycast_cli_present()` / `age_binary_present()` の確認（無ければエラー）
2. `age -d` で `passphrase_age_path()` を復号し、平文 passphrase を取得（メモリ上のみ、ファイル書き出し禁止）
3. `raycast export --type settings-and-data --output <tmp_path> --password <passphrase>` を実行（公式 Export Settings & Data: v1.22.0+、全 11 カテゴリ）
   - 公式 CLI フラグの正式名称は実装前に `raycast export --help` で実機確認し、その出力を `## 🐿️ メモ` に記録する
4. 出力ファイルが `Config` ヘッダ・暗号化済みバイト列であることを確認（`head -c 6` で `Config` マジック）
5. `chezmoi_source_dir() / "dot_Raycast.rayconfig"` へ move（上書き）
6. 差分がなければ `info: 差分なし、commit をスキップ` で正常終了
7. 差分があれば `git add chezmoi/dot_Raycast.rayconfig` → `git commit -m "chore(raycast): update settings"` → `git push`（既存 `src/git/common.rs:258` の `generate_commit_message` を流用検討）
8. 一時ファイル・復号済み passphrase の `Zeroize`（`zeroize` crate 利用、依存追加）

### 【高 4】`src/raycast/restore.rs` 新設

`pub fn run(_args: &[&str]) -> anyhow::Result<()>` を実装。手順:

1. 前提チェック: `raycast_cli_present()` / `age_binary_present()`
2. `git pull` で `chezmoi/dot_Raycast.rayconfig` を最新化（`src/git/common.rs` の pull 関数を流用）
3. `age -d` で passphrase を復号
4. `raycast import --type settings-and-data --input <rayconfig_path> --password <passphrase>` を実行
5. 完了メッセージ: `info: Raycast 設定を復元しました。手動で Raycast を再起動してください`
6. 復号済み passphrase の `Zeroize`

### 【高 5】`src/main.rs` 配線追加

`src/main.rs:3-9` の `mod` 宣言に `mod raycast;` を追加。
`src/main.rs:19-38` の `Commands` enum に `Raycast(raycast::RaycastCommands)` variant を追加（`#[command(subcommand)]` 属性、ドキュメントコメント `/// raycast: Raycast 設定の同期/復元`）。
`src/main.rs:43-51` の `match` に `Some(Commands::Raycast(cmd)) => raycast::run(cmd),` を追加。

### 【高 6】`chezmoi/dot_raycast_passphrase.age` 配置

- `age -r <自分の age 公開鍵> -o chezmoi/dot_raycast_passphrase.age` で暗号化した 8 文字以上の passphrase を配置
- 既存 `chezmoi/dot_zsh_secrets.age`（460 bytes）と同じディレクトリに並ぶ形
- 平文 passphrase は `/tmp/raycast_passphrase.txt` 等の作業ファイルに残さず、必ず `rm` する手順を README に明記
- 命名は暫定 `dot_raycast_passphrase.age`（Open Questions Q1 で確定）

### 【中 7】`chezmoi/dot_Raycast.rayconfig` 配置

- 初回は `raycast export` で生成したダミー（または既存実体のエクスポート）を配置
- Git の管理対象として登録（`.chezmoiignore` で除外しないこと）
- 空ファイルではなく、必ず暗号化済みバイナリを格納（公式 Export は暗号化必須）

### 【中 8】`src/raycast/shared.test.rs` 新設

- 既存 `src/chezmoi/shared.test.rs` の構造を踏襲
- テストケース案:
  - `chezmoi_source_dir()` が `CHEZMOI_SOURCE_DIR` 環境変数を尊重する
  - `chezmoi_source_dir()` が未設定時に `~/src/tools/chezmoi` を返す
  - `rayconfig_path()` が `chezmoi_source_dir() + "/dot_Raycast.rayconfig"` を返す
  - `passphrase_age_path()` が `chezmoi_source_dir() + "/dot_raycast_passphrase.age"` を返す
- 環境変数を弄るテストは `ENV_LOCK` で直列化

### 【中 9】`Cargo.toml` 依存追加

- `zeroize = "1"` を `[dependencies]` に追加（passphrase のメモリクリア用）
- その他必要な依存があればこのタスクでまとめて追加

### 【中 10】`README.md` / `chezmoi/README.md` 更新

- ルート `README.md`: 「サブコマンド一覧」に `raycast sync` / `raycast restore` を追記
- `chezmoi/README.md:10-15` のファイル一覧に `dot_Raycast.rayconfig` / `dot_raycast_passphrase.age` を追記
- 「passphrase ファイル更新手順」を新規セクションとして追加（既存 `dot_zsh_secrets.age` の更新手順と並列）

### 【低 11】`.gitignore` 等の調整確認

- `chezmoi/.chezmoiignore` に `dot_Raycast.rayconfig` / `dot_raycast_passphrase.age` が含まれていないことを確認
- ルート `.gitignore` にも追加不要（コミット対象）

---

## ✅ 確認手順

### ビルド・テスト

```bash
cd /Users/mt/src/tools
cargo build --release
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

### 動作確認

```bash
# 1. サブコマンド認識
./target/release/mt raycast --help
# 期待: "Usage: mt raycast <command>" と "sync", "restore" の表示

# 2. バイナリ存在チェック（パスが通っている前提）
./target/release/mt raycast sync
# 期待: 公式 Export 実行 → chezmoi/dot_Raycast.rayconfig 配置 → git commit & push
#       エラーなく終了コード 0

# 3. 復元
./target/release/mt raycast restore
# 期待: git pull → 復号 → raycast import 実行

# 4. Git 管理確認
cd ~/src/tools && git log --oneline -- chezmoi/dot_Raycast.rayconfig
# 期待: "chore(raycast): update settings" 等のコミットが積まれている
```

### 完了条件チェック

| # | 条件 | 確認方法 |
|---|---|---|
| 1 | `mt raycast sync` が一気通貫で動作 | 実行 → エラー 0・`.rayconfig` 更新・commit & push 完了 |
| 2 | `mt raycast restore` が自動化 | 実行 → import 完了・終了 0 |
| 3 | Git でバージョン管理 | `git log` で履歴が残る |
| 4 | passphrase が `.age` 暗号化 | `cat dot_raycast_passphrase.age | head` で平文が見えない |
| 5 | 既存 `mt chezmoi` を壊さない | `mt chezmoi --help` が従来通り動作 |
| 6 | 11 カテゴリが 1 ファイルに格納 | `raycast import` 復元後に全設定が反映されていることを目視確認 |

---

## 🚧 Open Questions（実装着手前に解消）

- **Q1.** passphrase ファイルの最終命名は `dot_raycast_passphrase.age` で確定で良いか？代替案: `dot_raycast_export_passphrase.age`（より明示的） / `dot_raycast_secret.age`（既存 `dot_zsh_secrets.age` と対称）
- **Q2.** `mt raycast restore` 実行時の passphrase 復号化タイミングと方式: ① 毎回 `age -d` で復号（安全、起動時 1 秒程度） / ② 環境変数 `RAYCAST_PASSPHRASE` 経由 / ③ 起動時キャッシュ（速度優先、メモリ常駐）
- **Q3.** 公式 Export 11 カテゴリのうち、Secret 含有カテゴリ（API キー等）だけ commit 対象外にする個別制御を入れるか？入れない場合、全て暗号化されたまま 1 ファイルに格納（暗号化されている以上、漏洩リスクは限定的）
- **Q4.** 公式 `raycast export` / `raycast import` の CLI フラグ正式名称（`--password` / `--passphrase` / `-p` など）を実機で確認する必要あり。実装開始時に `raycast export --help` の出力を `## 🐿️ メモ` に転記する想定
```

## 🐢 履歴
- 2026-06-30 02:05 [refined] draft から遷移
- 2026-06-30 mt-create-plan Grill Phase 完了、Issue #3 を plan 化（`draft` ステータス）
- 2026-06-30 mt-run-plan 着手に向けて対話モードでタスク指示書を生成（本ドキュメント）