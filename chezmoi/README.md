# chezmoi ソースディレクトリ

このディレクトリは chezmoi のソースディレクトリ（dotfile の Source of Truth）です。
`tools` 親リポジトリの plain directory として tracking されており、chezmoi サブ git repo ではありません。

## ファイル構成

| ファイル | 種別 | 役割 |
| --- | --- | --- |
| `dot_zshrc.tmpl` | template | `~/.zshrc` のテンプレート。`{{ include "dot_zsh_secrets.age" \| decrypt -}}` 経由で API キーを展開（trim 付き） |
| `dot_zprofile` | plain | `~/.zprofile` の plain コピー |
| `dot_gitconfig` | plain | `~/.gitconfig` の plain コピー |
| `dot_zsh_secrets.age` | age 暗号化 | API キーなどの secrets（age 公開鍵で暗号化） |
| `.chezmoiignore` | chezmoi | この README を chezmoi apply の対象外にする |
| `README.md` | doc | このファイル（chezmoi ソースの doc であって dotfile ではない） |

## 初回セットアップ

1. chezmoi と age を brew でインストール（`manifests/Brewfile` の `brew "chezmoi"` / `brew "age"` 経由で `mt tool install`）
2. age 秘密鍵を生成: `age-keygen -o ~/.config/chezmoi/key.txt`（パスフレーズなし推奨）
3. `~/.config/chezmoi/chezmoi.toml` を作成:

    ```toml
    sourceDir = "/Users/mt/src/tools/chezmoi"
    encryption = "age"

    [age]
    identity = "/Users/mt/.config/chezmoi/key.txt"
    ```

4. dotfile を展開: `mt chezmoi apply`（`chezmoi apply` と同等）

`chezmoi.toml` はユーザー固有の chezmoi 設定で、`~/.config/chezmoi/` 配下にあり git にはコミットされません。
`chezmoi/` ソースディレクトリ自体には `chezmoi.toml` を **置かない** 設計です（git 追跡される親リポジトリにローカルパスを埋め込まないため）。

## 編集ワークフロー

```bash
# chezmoi ソースを直接編集（vim / Cursor / お好みのエディタ）
vim ~/src/tools/chezmoi/dot_zshrc.tmpl

# 変更をプレビュー（実際に反映せず差分確認）
mt chezmoi diff

# 変更を反映
mt chezmoi apply

# 状態確認
mt chezmoi status
```

`chezmoi/` 配下の編集後、git commit → push で Source of Truth を更新します。

## secrets の追加・更新

`dot_zsh_secrets.age` を更新する手順:

1. 公開鍵を確認: `age-keygen -y ~/.config/chezmoi/key.txt`
2. 平文ファイル（git コミット対象外）を作成:

    ```bash
    printf 'export TAVILY_API_KEY=...\n\n# firecrawl\nexport FIRECRAWL_API_KEY=...\n' > /tmp/zsh_secrets.txt
    ```

3. 暗号化: `age -r age1xxx... -o ~/src/tools/chezmoi/dot_zsh_secrets.age /tmp/zsh_secrets.txt`
4. `chezmoi/` 配下の差分確認: `git diff chezmoi/dot_zsh_secrets.age`
5. git commit

平文ファイル（`/tmp/zsh_secrets.txt` 等）は必ず削除してください。

## 関連 Plan

- `tmp/plan/in-progress/20260626-chezmoi-foundation.md`（Phase 1: 個人 dotfiles + `mt chezmoi` サブコマンド）
- `tmp/plan/refined/20260626-chezmoi-agent-configs-migration.md`（Phase 2: `agent-configs/` 廃止 + 統合 hook。Phase 1 完了後に着手）

