# ツール管理マニフェスト

このディレクトリは PC にインストールする開発ツールの Single Source of Truth です。Homebrew、mise、bun global の各マニフェストを格納し、`mt tool` サブコマンドで一元管理します。

> 設計判断は [ADR 0003: manifests/ を PC ツール管理の Single Source of Truth とする](../docs/adr/0003-manifests-ssot.md) を参照。

## ファイル構成

| ファイル | 管理対象 | 役割 |
| --- | --- | --- |
| `Brewfile` | Homebrew | CLI ツール、cask アプリ、VSCode 拡張の宣言 |
| `mise.toml` | mise | ランタイム（bun, node, rust）のバージョン宣言 |
| `bun-global.yml` | bun global | bun グローバルパッケージの存在管理 |

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

### ツールの追加・変更

- Homebrew パッケージの追加: `manifests/Brewfile` を編集して `mt tool install`
- mise のツールバージョン変更: `manifests/mise.toml` を編集して `mt tool install`
- bun global package の追加・削除: `manifests/bun-global.yml` を編集して `mt tool install`
