## Issue #12: serde_yaml から yaml_serde への移行

## 💭 背景

`Cargo.toml` の `serde_yaml = "0.9"` は 2024 年に deprecated になっており、メンテナンスされていない。deprecation 警告はビルド時に出力され続け、`unsafe-libyaml` への依存も抱えている。

既存 Issue #10 (`serde_yaml から serde_yml への移行`) で `serde_yml` への移行を計画していたが、2026-06-28 の調査で `serde_yml` 自体が **RUSTSEC-2025-0068 で unsound (segfault)** として警告され、GitHub repo も archived されていることが判明した。`serde_yml` 公式 README で案内されている移行先 `noyalib` も RUSTSEC で "Incomplete pure Rust alternatives" 扱いで、デファクトとは言いがたい。

一方、**公式 YAML 組織 (yaml/yaml-serde)** が `serde_yaml` の actively maintained fork として **`yaml_serde`** を公開している (2026-03 公開、lib.rs 統計: 282K dl/月、189 crate 使用)。公式 README に "This fork continues development with full compatibility" と明記されており、`serde_yaml` 0.9 からの移行は import 書き換えのみで完結する。

Issue #9 (done, 2026-06-27) の実装で `src/tool/shared.rs` にも YAML パーサが追加されたため、リポジトリ全体 (`src/vector/` と `src/tool/`) を一括で `yaml_serde` へ統一する。

Issue #10 は本計画の前提調査として活用し、本計画 (新 Issue) が正式な移行計画となる。Issue #10 は `in-progress` 保留状態として残す。

## ✅ 完了条件

1. `Cargo.toml` の `serde_yaml = "0.9"` が `yaml_serde = "0.10"` に置換されている
2. `src/vector/frontmatter.rs` の `serde_yaml::Value` / `serde_yaml::from_str` が `yaml_serde` 経由になっている
3. `src/vector/frontmatter.test.rs` の `serde_yaml::Value` / `serde_yaml::from_str` が `yaml_serde` 経由になっている
4. Issue #9 で追加された `src/tool/shared.rs` の yml パーサも `yaml_serde` 経由になっている
5. `cargo build` が成功する
6. `cargo test` が全テスト成功する
7. `cargo clippy --all-targets -- -D warnings` がパスする
8. `cargo update -p yaml_serde` で semver 互換範囲の最新版に更新されている
9. `cargo fmt` が適用されている
10. リポジトリ内に `serde_yaml` への参照が一切残っていない (`grep -r serde_yaml src/ Cargo.toml Cargo.lock` が空)
11. `Cargo.lock` から `serde_yaml` および `unsafe-libyaml` の依存が完全に消えている (`cargo tree` で確認)

## 📦 アウトプット

### ファイル変更

- 修正: `Cargo.toml` (`serde_yaml` 削除、`yaml_serde` 追加)
- 修正: `Cargo.lock` (再生成)
- 修正: `src/vector/frontmatter.rs` (import 書き換え)
- 修正: `src/vector/frontmatter.test.rs` (import 書き換え)
- 修正: `src/tool/shared.rs` (Issue #9 由来の yml パーサを `yaml_serde` で記述)

### 検証ログ

- `cargo build` / `cargo test` / `cargo clippy --all-targets -- -D warnings` / `cargo fmt --check` / `cargo update -p yaml_serde` / `cargo tree` の実行結果

## 🧭 方針

### 進め方の原則

1. **直接 import 変更方式**: package renaming (`serde_yaml = { package = "yaml_serde", version = "0.10" }`) は使わず、`use serde_yaml::` → `use yaml_serde::` に明示的に置換する。完了条件 10 (`grep -r serde_yaml` が空) を完全達成するため
2. **API 互換性前提**: `yaml_serde` 公式 README に "This fork continues development with full compatibility" と明記。関数名・型名・トレイトの改名なしで移行可能。万一互換性問題が出たら別 Issue 化して本計画に組み込まない
3. **依存の最小化**: 置換後 `serde_yaml` および `unsafe-libyaml` への依存が `Cargo.lock` から完全に消えていることを `cargo tree` で確認
4. **検証は cargo フルセット**: `cargo build` / `cargo test` / `cargo clippy` / `cargo fmt` の 4 つを「成功」の判定基準とする
5. **Issue #10 の履歴を尊重**: Issue #10 は本計画の前提調査として残す。`in-progress` 保留状態を維持

### AI 判断範囲・Human Gate

#### AI 判断

- `Cargo.toml` のバージョン文字列 (`yaml_serde` の最新版) の選定
- import 文の機械的書き換え
- `cargo update -p yaml_serde` の実行
- `cargo tree` での依存確認
- API 互換性問題発生時の一次切り分け

#### ユーザー確認 (Human Gate)

- API 互換性問題発生時の対応方針 (Issue 化 / 修正対応 / 計画保留のいずれか)
- `cargo clippy` で新規 warning が出たときの対応 (lint 緩和 vs 修正対応)
- **cargo fmt スコープ外波及 7 ファイルの取扱い** (本 Issue のコミットに含めるか別 commit に分離するか、fix ステップの所見参照)

### 想定 Cargo.toml 変更

```diff
- serde_yaml = "0.9"
+ yaml_serde = "0.10"
```

(version 文字列は `cargo update` 後に最新 semver 互換範囲に確定。2026-01-24 時点で 0.10.3 が最新)

### 想定 import 書き換え

```diff
- use serde_yaml::Value;
+ use yaml_serde::Value;

- serde_yaml::from_str(...)
+ yaml_serde::from_str(...)
```

## 🐿️ メモ

### 関連 Issue

- Issue #10 (`serde_yaml から serde_yml への移行`) — 2026-06-28 に `in-progress` 保留。本計画が supersede 関係

### 移行先選定の経緯

- 2026-06-28 時点で RUSTSEC-2025-0068 を発端に `serde_yml` が unsound と判明
- 候補比較 (lib.rs 統計): `serde_norway` 458K dl/月 / `yaml_serde` 282K dl/月 (公式 YAML org) / `noyalib` 5,268 dl/月
- `yaml_serde` 採用理由: 公式 YAML 組織が管理 (権威性) + 公式 README で "full compatibility" 明記 + ダウンロード規模が十分

### cargo fmt のスコープ外波及 7 ファイル (reviewers 指摘を受け、fix ステップで明文化)

`cargo fmt` 実行により、serde_yaml 移行の明示的スコープ (4 ファイル + Cargo.lock) 以外に **7 ファイル** に cargo fmt による機械的整形が及んだ。

- `src/chezmoi/doctor.rs`
- `src/chezmoi/doctor.test.rs`
- `src/chezmoi/install_hook.rs`
- `src/chezmoi/uninstall_hook.rs`
- `src/git/worktree.rs`
- `src/git/worktree.test.rs`
- `tests/chezmoi_cli.rs`

**事実確認 (fix ステップで `git stash` 検証済み)**: これら 7 ファイルは **本 Issue 開始前の pre-execution ベースライン時点で既に `cargo fmt --check` が失敗する状態** だった (rustfmt 設定との不整合が潜んでいた)。本 Issue で `cargo fmt` を実行した結果、これらが「修正された」形で波及した。

**fix ステップの判断**:
- `git checkout -- <7 ファイル>` で revert すると pre-existing 違反が再浮上し、**完了条件 #9 (`cargo fmt` が適用されている) を満たせなくなる**。
- 一方で、7 ファイルの機械的整形を本 Issue のコミットに混ぜるのは、scope レビューア・policy レビューアの指摘どおり「serde_yaml 移行とは無関係な変更の混入」になる。
- 採否は **Human Gate** として done-gate でユーザー判断に委ねる:
  - **(A) 維持**: 7 ファイル分の整形も含めて 1 commit でマージ (本 Issue の作業がそのまま完了)
  - **(B) コミット分離**: 機能変更 4 ファイル + 7 ファイル整形を別 commit に分離してマージ (fix ステップでは commit 操作不可、ワークフロー完了後の手動操作が必要)
  - **(C) 別 Issue 化**: 7 ファイル分の整形を別 Issue として切り出し、本 Issue は 4 ファイル機能変更のみ

fix ステップでは **(A) 維持** の状態で fix-report を生成。`(B)` または `(C)` を選ぶ場合はワークフロー完了後にユーザー側で対応。

### レビュー指摘一覧 (fix ステップで取り込み)

scope / policy レビューアが共通で指摘した内容:

1. **should: cargo fmt スコープ外波及 7 ファイル** — 上記セクション参照 (Human Gate)
2. **should: 実行レポートの不整合** — `execution-report.md` (本体) が「ソースファイルに変更を加えず」と虚偽記載していたが、実体は Cargo.toml / ソース / Cargo.lock に変更あり。fix ステップで本体を正しい内容に書き換え、バックアップ (`.20260629T183248Z`) を削除
3. **want: 実行レポートの重複** — バックアップ削除で解消

essence / completeness / quality レビューは APPROVE (must 指摘 0 件)。quality レビューは概ね妥当だが、ジェネリックな内容 (Vitest / Jest 言及など JavaScript 前提) が混じっており、コード固有の品質指摘は実質なし。

## 🐢 履歴
- 2026-06-30 03:46 [in-progress] fix 完了: 5 観点レビューで must 指摘 0 件。should 指摘 (cargo fmt 波及 7 ファイル、レポート不整合) に対応 — `execution-report.md` を実体に合わせて書き換え、バックアップを削除。cargo fmt 波及 7 ファイルの採否は Human Gate として done-gate に送る
- 2026-06-30 03:30 [in-progress] execute 完了: serde_yaml→yaml_serde 移行実施。build/test/clippy/fmt 全て成功、grep/cargo tree で serde_yaml/unsafe-libyaml ゼロ確認
- 2026-06-30 03:29 [in-progress] refined から遷移
- 2026-06-28 21:48 [refined] draft から遷移
- 2026-06-28 01:35 [draft] Grill Phase 完了、起票


### Labels
kind/plan