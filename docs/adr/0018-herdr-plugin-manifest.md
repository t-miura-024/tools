---
status: accepted
---

# herdr プラグインを manifests/herdr-plugins.toml で宣言管理する

herdr のプラグインは `manifests/herdr-plugins.toml` に宣言し、`mt herdr plugin sync` で反映する。バージョンは pin せず最新を追従し、manifest 外の GitHub 導入は削除候補として確認した上で uninstall する。ADR 0003 の manifests/ SSOT の対象を herdr プラグインへ拡張する。

## Context

- ADR 0003 で `manifests/` を PC ツール管理の Single Source of Truth と定めたが、herdr プラグインは対象外だった
- 導入済みプラグインの実体（`~/.config/herdr/plugins.json` + `plugins/`）は resolved commit や hash 付き絶対パスを含む生成物であり、dotfile として直接配布すると環境差・バージョン差で壊れやすい
- herdr v1 には `plugin update` がなく、GitHub 管理プラグインの再 install が更新の公式フロー。install / uninstall は shorthand（`owner/repo[/subdir]`）を受け付ける
- プラグインのソースはユーザー自身のリポジトリ（zenbu-labs）であり、常に最新を追従する運用を望む

## Decision

- `manifests/herdr-plugins.toml` に `[[plugin]] source = "<OWNER/REPO[/SUBDIR]>"` を宣言する。ref フィールドは持たない（最新追従）
- `mt herdr plugin sync` — manifest 全エントリへ `herdr plugin install <source> --yes` を実行する（既存導入は managed checkout の置き換え = 更新）。その後、GitHub 管理の導入済みプラグインと manifest の差分を表示し、確認後に manifest 外を uninstall する
- ローカル link 等の GitHub 管理外プラグインは同期対象外として報告のみ行う
- `mt tool verify`（および `mt doctor`）に herdr プラグインの presence ベース drift 検査を追加する（未導入・manifest 外を検出し、状態変更はしない）。バージョン比較は行わない
- `mt tool install` の最終ステップで herdr プラグイン同期を実行する
- enabled / disabled 状態は manifest では管理しない
- herdr との統合境界は plugin CLI（`plugin list --json` / `install` / `uninstall`）とし、`plugins.json` や socket の内部形式には依存しない（ADR 0012 と同方針）

## Considered Options

- chezmoi で宣言と適用スクリプトを配布する方式: post-commit hook で自動反映できるが、Rust 側の verify/drift 検出と分離して二重管理になる。
- `plugins.json` を直接 dotfile 配布する: hash 付きパスと resolved commit を含む生成物の管理になり、herdr の内部形式変更に脆弱。

## Consequences

- 新マシンで `mt tool install` 一発で herdr 本体（Brewfile）とプラグイン構成が復元される
- バージョンは pin されないため、過去時点の完全な再現はできない（意図的判断）。特定リビジョンの固定が必要になった時点で manifest に ref フィールドを追加して拡張する
- sync のたびに全エントリが再 clone され、各プラグインの build command（installer 系コマンド）が再実行される
- manifest 外の手動導入プラグインは verify で drift として検出され、sync で削除確認が出る。enabled 状態や plugin config-dir の内容は管理外のため、手運用が残る
