# ツール管理マニフェスト

このディレクトリは PC にインストールする開発ツールの Single Source of Truth です。Homebrew、mise、bun global、herdr plugin の各マニフェストを格納し、`mt tool` / `mt herdr` サブコマンドで一元管理します。

> 設計判断は [ADR 0003: manifests/ を PC ツール管理の Single Source of Truth とする](../docs/adr/0003-manifests-ssot.md)、herdr プラグインの方式は [ADR 0018: herdr プラグインを manifests/herdr-plugins.toml で宣言管理する](../docs/adr/0018-herdr-plugin-manifest.md) を参照。

## ファイル構成

| ファイル | 管理対象 | 役割 |
| --- | --- | --- |
| `Brewfile` | Homebrew | CLI ツール、cask アプリ、VSCode 拡張の宣言 |
| `mise.toml` | mise | ランタイム（bun, node, rust）のバージョン宣言 |
| `bun-global.yml` | bun global | bun グローバルパッケージの存在管理 |
| `herdr-plugins.toml` | herdr plugin | herdr プラグインの存在管理（最新追従） |

## 使い方

### 初回セットアップ

```bash
mise trust manifests/mise.toml
```

### 一括インストール

```bash
mt tool install
```

`mt tool install` は manifest に書かれたツールをインストールした後、`Brewfile` 管理対象外の依存、未使用の mise tool version、`bun-global.yml` 管理対象外の bun global package を表示します。削除候補がある場合は確認プロンプトを出し、承認したときだけ削除します。

`bun-global.yml` は bun global package の存在を管理します。package が CLI binary を提供しない場合、package はインストールされても同名コマンドとして使えるとは限りません。

`bun-global.yml` の各エントリは `version` または `repo` のいずれか一方を指定します。両方の指定、または両方の未指定はバリデーションエラーになります。

- `version: latest` — registry パッケージ（npm 等）の宣言。`latest` で最新版を追従します
- `repo: <owner>/<name>` — GitHub ホストパッケージの宣言。`<owner>/<name>` 形式でリポジトリを指定し、デフォルトブランチの最新に追従します（例: `tado: repo: t-miura-024/tado`）

```yaml
packages:
  tado:
    repo: t-miura-024/tado
```

### 管理状態の確認

```bash
mt tool verify
```

- Homebrew: manifest に書かれたパッケージが入っているか確認（outdated 状態は失敗扱いにしない）
- mise: `mise install --dry-run-code` で未インストールを検出
- bun global: `manifests/bun-global.yml` のパッケージが未インストールなら失敗
- verify は確認だけを行い、不足ツールのインストールは行わない

### Homebrew パッケージの更新

```bash
mt tool brew upgrade
```

Homebrew のみを対象にし、mise のバージョンは自動更新しません。

### bun global パッケージの更新

```bash
mt tool bun upgrade
```

`manifests/bun-global.yml` に記載された package を一括更新します。registry パッケージ（`version:` エントリ）は最新版に、GitHub ホストパッケージ（`repo:` エントリ）はデフォルトブランチの最新コミットに更新されます。bun global のみを対象にし、Homebrew / mise は更新しません。

### mise ツールの更新

```bash
mt tool mise upgrade
```

`manifests/mise.toml` の指定範囲内で更新します。`latest` / `stable` などの追従エントリは最新に更新され、固定バージョン（例: `node = "26.1.0"`）はそのまま維持されます。mise.toml は書き換えず、Homebrew / bun global は更新しません。

### ツールの追加・変更

- Homebrew パッケージの追加: `manifests/Brewfile` を編集して `mt tool install`
- mise のツールバージョン変更: `manifests/mise.toml` を編集して `mt tool install`
- bun global package の追加・削除: `manifests/bun-global.yml` を編集して `mt tool install`（registry パッケージは `version:` で、GitHub ホストパッケージは `repo:` で宣言）

### herdr プラグインの追加・削除

```bash
# manifests/herdr-plugins.toml
[[plugin]]
source = "zenbu-labs/terminal-browser/herdr-plugin"
```

```bash
mt herdr plugin sync
```

`source` は `herdr plugin install <OWNER/REPO[/SUBDIR]>` と同じ shorthand で書き、バージョンは pin せず最新を追従します（再 install が更新の公式フロー）。sync は manifest 全エントリを導入・更新した後、manifest 外の GitHub 導入プラグインを削除候補として表示し、承認したときだけ uninstall します。ローカル link 中のプラグインは同期対象外です。
