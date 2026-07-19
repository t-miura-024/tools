# chezmoi ソースディレクトリ

個人 dotfiles（`~/.zshrc`, `~/.zprofile`, `~/.gitconfig`）と AI agent 設定（Cursor / Claude / OpenCode）は、この `chezmoi/` ディレクトリに集約し、`chezmoi apply` 経由で `~` へデプロイします。Phase 2 で `agent-configs/` を完全廃止し、`mt agent-config` サブコマンドを削除、`chezmoi` 経由に統合しました。

> 設計判断は以下 ADR を参照:
> - [ADR 0002: dot_cursor を canonical とする AI agent 設定管理](../docs/adr/0002-dot-cursor-canonical-rules.md)
> - [ADR 0004: agent-configs/ の廃止と chezmoi 統合](../docs/adr/0004-agent-configs-abolishment.md)

## ディレクトリ構成

`chezmoi/` 直下の `dot_cursor/`, `dot_claude/`, `dot_config/opencode/` が agent 設定の格納先です。**`dot_cursor/agents/` が canonical** で、`dot_claude/agents/` と `dot_config/opencode/agents/` は `mt agent sync` によって自動生成されます。skills も `dot_cursor/skills/` が canonical で、派生プラットフォームへは symlink で共有されます。

```
chezmoi/
├── dot_zshrc.tmpl             # ~/.zshrc（テンプレート、API キー復号）
├── dot_zprofile               # ~/.zprofile（plain copy）
├── dot_gitconfig              # ~/.gitconfig（plain copy）
├── dot_zsh_secrets.age        # age 暗号化ファイル（git コミット対象、age 鍵で復号）
├── README.md                  # このファイル（chezmoi apply から除外）
├── dot_cursor/                # ~/.cursor/ へデプロイ
│   ├── agents/                # canonical（name, description, readonly）
│   ├── skills/                # canonical
│   └── hooks.json             # Cursor PreToolUse 設定
├── dot_claude/                # ~/.claude/ へデプロイ
│   ├── CLAUDE.md              # Source of Truth 記述
│   ├── agents/                # Claude 形式（description: Use this agent when...）
│   ├── skills/                # Claude 形式
│   └── settings.json          # Claude PreToolUse 設定
└── dot_config/                    # ~/.config/ へデプロイ
    ├── starship.toml              # ~/.config/starship.toml（plain copy）
    └── opencode/                  # ~/.config/opencode/ へデプロイ
        ├── AGENTS.md              # Source of Truth 記述
        ├── agents/                # opencode 形式（mode, permission, color）
        ├── skills/                # opencode 形式
        ├── plugins/               # opencode プラグイン
        │   ├── cmux-notify.ts     # cmux 通知プラグイン
        │   ├── mt-loop-engine.ts  # mt loop engine
        │   ├── cursor-hook-bridge.ts  # Cursor の hooks.json を opencode plugin に bridge
        │   └── agent-hooks/
        │       └── block-cursor-config-direct-edit.ts  # 共通 hook スクリプト
        ├── commands/              # opencode slash commands
        │   ├── mt-goal.md
        │   └── mt-loop.md
        └── config.json            # opencode 設定（plugin: cursor-hook-bridge）
```

## ファイル構成

| ファイル | 種別 | 役割 |
| --- | --- | --- |
| `dot_zshrc.tmpl` | template | `~/.zshrc` のテンプレート。`{{ include "dot_zsh_secrets.age" \| decrypt }}` 経由で API キーを展開 |
| `dot_zprofile` | plain | `~/.zprofile` の plain コピー |
| `dot_gitconfig` | plain | `~/.gitconfig` の plain コピー |
| `dot_zsh_secrets.age` | age 暗号化 | API キーなどの secrets（age 公開鍵で暗号化） |
| `dot_Raycast.rayconfig` | Raycast 暗号化 | Raycast Export 全データ（passphrase で暗号化、git 追跡） |
| `dot_raycast_passphrase.age` | age 暗号化 | Raycast 暗号化 passphrase（age 公開鍵で暗号化） |
| `.chezmoiignore` | chezmoi | この README を chezmoi apply の対象外にする |
| `README.md` | doc | このファイル（chezmoi ソースの doc であって dotfile ではない） |

## 初回セットアップ

1. `mt tool install` で chezmoi と age を brew 経由でインストール（`manifests/Brewfile` の `brew "chezmoi"` / `brew "age"` が自動追加される）
2. age 秘密鍵を生成:

    ```bash
    age-keygen -o ~/.config/chezmoi/key.txt
    ```

3. `~/.config/chezmoi/chezmoi.toml` を作成（git コミット対象外、ユーザー固有設定）:

    ```toml
    sourceDir = "/Users/mt/src/tools/chezmoi"
    encryption = "age"

    [age]
    identity = "/Users/mt/.config/chezmoi/key.txt"
    ```

    `chezmoi/` ソースディレクトリ自体には `chezmoi.toml` を **置かない** 設計です（git 追跡される親リポジトリにローカルパスを埋め込まないため）。

4. dotfile を展開:

    ```bash
    mt chezmoi apply
    ```

## secrets の暗号化

`dot_zsh_secrets.age` のような age 暗号化ファイルで API キーなどの secrets を管理できます。テンプレート側で `{{ include "dot_zsh_secrets.age" | decrypt }}` と書くと復号結果が展開されます。

### `mt chezmoi secret` での管理

`mt chezmoi secret set` / `mt chezmoi secret delete` で 1 コマンドで secret を追加・更新・削除できます。

```bash
# KEY を追加（パスワードプロンプトで値を入力）
mt chezmoi secret set MY_API_KEY

# 既存 KEY を更新（上書き確認あり）
mt chezmoi secret set MY_API_KEY

# KEY を削除（確認あり）
mt chezmoi secret delete MY_API_KEY

# KEY 省略時は一覧から選択
mt chezmoi secret delete

# 内容をプレビュー（ファイル変更なし）
mt chezmoi secret set MY_API_KEY --dry-run
mt chezmoi secret delete MY_API_KEY --dry-run
```

内部的には `dot_zsh_secrets.age` を復号 → 追記/削除 → 再暗号化し、原子書き換えのため破損しません。
実行後に `mt chezmoi apply` を実行するか確認されます（`--no-apply` でスキップ可）。

平文フォーマットは固定ヘッダ + 連続 `export` です（set/delete 実行時に正規化）:

```
# Secrets（chezmoi で age 暗号化）
export TAVILY_API_KEY=...
export FIRECRAWL_API_KEY=...
export MY_API_KEY=...
```

### 旧手順（手動）

手動で行う場合の参考手順:

1. 公開鍵を確認: `age-keygen -y ~/.config/chezmoi/key.txt`
2. 平文ファイル（git コミット対象外）を作成:

    ```bash
    printf 'export TAVILY_API_KEY=...\n\n# firecrawl\nexport FIRECRAWL_API_KEY=...\n' > /tmp/zsh_secrets.txt
    ```

3. 暗号化: `age -r age1xxx... -o ~/src/tools/chezmoi/dot_zsh_secrets.age /tmp/zsh_secrets.txt`
4. `chezmoi/` 配下の差分確認: `git diff chezmoi/dot_zsh_secrets.age`
5. git commit

平文ファイル（`/tmp/zsh_secrets.txt` 等）は必ず削除してください。

## 編集ワークフロー

```bash
# 1. canonical（dot_cursor/）を編集
vim ~/src/tools/chezmoi/dot_cursor/agents/foo.md

# 2. Claude / OpenCode 派生を同期生成
mt agent sync

# 3. 差分プレビュー（--dry-run で書き込みなし確認も可）
mt agent sync --dry-run
mt chezmoi diff

# 4. 反映
mt chezmoi apply

# 5. 状態確認
mt chezmoi status

# 6. ソース変更をコミット
cd ~/src/tools
git add chezmoi/
git commit -m "..."
```

`mt self install` を実行すると `chezmoi apply` + `cargo install --path .` が自動実行され、`~/.zshrc` や platform 設定ファイルへの直接書き込みは行いません（chezmoi 経由のみ）。

## `mt chezmoi doctor`

chezmoi ネイティブ doctor に加え、以下を `mt` 固有チェックとして実行:

- `CHEZMOI_SOURCE_DIR` 環境変数 or `~/.config/chezmoi/chezmoi.toml` の `sourceDir` 設定
- `~/.config/chezmoi/key.txt` の存在と妥当性（`AGE-SECRET-KEY-` プレフィックス）
- post-commit hook の設置状態
- `agent-configs/` ディレクトリの削除確認（chezmoi 移管完了確認）
- agent/skill sync 状態の確認（未同期の場合は非0終了）
- platform-native hook 4 ファイル（`~/.cursor/hooks.json` / `~/.claude/settings.json` / opencode bridge / 共通 hook スクリプト）の配置確認

## platform-native hook

3 つの platform（Cursor / Claude / OpenCode）に対して chezmoi 経由で `block-cursor-config-direct-edit.ts` を共通配置し、保護ルート（`~/.cursor/`, `~/.claude/`, `~/.config/opencode/`, `tools/chezmoi/dot_claude/`, `tools/chezmoi/dot_config/opencode/`）配下への直接編集を deny します。canonical である `tools/chezmoi/dot_cursor/` への編集は許可されます。

- `~/.cursor/hooks.json` の `preToolUse` matcher → Cursor 用エントリ
- `~/.claude/settings.json` の `PreToolUse` matcher → Claude Code 用エントリ
- `~/.config/opencode/plugins/cursor-hook-bridge.ts` → OpenCode の `tool.execute.before` プラグイン

`mt chezmoi install-hook` で `chezmoi apply` + 旧 `~/.claude/hooks/agent-hooks/` 配下のクリーンアップを冪等に実行します。`mt chezmoi uninstall-hook` は chezmoi source 内の platform hook 設定を無効化する手順を案内します。

## OpenCode × cmux 統合

`chezmoi/dot_config/opencode/plugins/cmux-notify.ts` は opencode のプラグインで、opencode のセッション状態変化を cmux に通知し、サイドバータブに status バッジを出します。

購読イベント:
- `session.status` (`busy`) → ⚡️ 青色バッジ "Running" + 進捗インジケータ
- `session.status` (`retry`) → ↻ 橙色バッジ "Retrying"
- `session.status` (`idle`) → バッジクリア
- `session.idle` → バッジクリア + 通知 "Task complete"
- `session.error` → ❌ 赤色バッジ "Error" + 通知 "Error"
- `permission.updated` → 通知 "Waiting for input"

`mt chezmoi apply` で `~/.config/opencode/plugins/cmux-notify.ts` へデプロイされ、opencode 起動時に自動ロードされます。`cmux` バイナリが PATH にない場合は no-op で安全（クラッシュしません）。

必要要件:
- [cmux](https://cmux.app/) をインストールし PATH へ追加（`export PATH="/Applications/cmux.app/Contents/MacOS:$PATH"`）
- `mt chezmoi apply` を 1 回実行

通知挙動をカスタマイズしたい場合は `chezmoi/dot_config/opencode/plugins/cmux-notify.ts` を編集して `mt chezmoi apply` で反映してください。`~/.config/opencode/plugins/` 配下を直接編集すると platform-native hook によってブロックされます。

## Raycast 設定の管理

`dot_Raycast.rayconfig` は Raycast の Export Settings & Data 機能（GUI）で生成される暗号化ファイルです。
`dot_raycast_passphrase.age` に age 暗号化された passphrase を格納します。

両ファイルとも `.chezmoiignore` により `chezmoi apply` の対象から除外されており、`~/` に誤展開されません。

### 管理ファイル

| ファイル | 種別 | 役割 |
| --- | --- | --- |
| `dot_Raycast.rayconfig` | Raycast 暗号化 | Export 全データ（passphrase で暗号化、chezmoi apply 対象外） |
| `dot_raycast_passphrase.age` | age 暗号化 | Raycast Export passphrase（age 公開鍵で暗号化、chezmoi apply 対象外） |

### 初回セットアップ

```bash
# passphrase を決める（8 文字以上）
PASSPHRASE="your-secure-passphrase-here"

# 公開鍵を確認
age-keygen -y ~/.config/chezmoi/key.txt

# passphrase を暗号化して chezmoi ソースに配置
printf '%s' "$PASSPHRASE" | age -r age1... -o ~/src/tools/chezmoi/dot_raycast_passphrase.age
```

### 更新ワークフロー

```bash
# 1. mt が Export 画面を開き、passphrase を表示 → Raycast GUI で Export 実行 → ファイルを chezmoi に取り込み
mt raycast sync

# 2. 差分確認
git diff chezmoi/dot_Raycast.rayconfig

# 3. コミット
git add chezmoi/dot_Raycast.rayconfig
git commit -m "backup: Raycast settings $(date +%Y-%m-%d)"
```

### 復元

```bash
# mt がバックアップパスと passphrase を表示 → Raycast GUI で Import Settings & Data を実行
mt raycast restore
```
