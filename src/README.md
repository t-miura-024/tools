# src ディレクトリ構成ルール

`mt` の Rust ソースは、以下の 2 つのルールに従ってファイルを配置する。
新しいコマンドやサブコマンドを追加するときは、必ずこのルールに沿わせること。

## ルール A: `src` 直下はインデックスまたは設定のみ

`src` 直下に置くファイルは、次のいずれかの役割に限定する。実装ロジックを直接書かない。

- **インデックス**: モジュール集約（`pub mod` / `mod` 宣言）、`clap` のコマンド定義（`Subcommand` enum）、サブコマンドへの dispatch（`run` 関数）。
- **設定**: アプリ横断で使う設定値・設定型の定義。

現状の対応は次のとおり。

| ファイル | 役割 |
|---|---|
| `src/main.rs` | エントリポイント、トップレベルコマンド定義と dispatch |
| `src/cli.rs` | `cli` モジュールの集約 |
| `src/git.rs` | `git` サブコマンド定義と dispatch |
| `src/opencode.rs` | `opencode` サブコマンド定義と dispatch |
| `src/tool.rs` | `tool` サブコマンド定義と dispatch |
| `src/difit.rs` | `difit` レビューセッション管理（`mt difit`）のサブコマンド定義と dispatch |
| `src/config.rs` | アプリ横断の設定（ホームディレクトリ解決、OAuth 設定型など） |

サブコマンドの実装本体（処理ロジック）を `src` 直下のファイルに書いてはいけない。
実装は対応するディレクトリ配下（ルール B）へ置く。

## ルール B: `src` 直下のディレクトリ配下はサブコマンド単位で分割

コマンドグループ（`git` / `opencode` / `tool` など）に対応するディレクトリの中では、
**親モジュール直下のサブコマンド単位**で 1 ファイルに分割する。

分割の基準は次のとおり。

- 1 ファイル = 親モジュール直下の 1 サブコマンド。
- そのサブコマンド配下の**末端コマンド（それ以上サブコマンドを持たない実行コマンド）は、
  同じファイルにまとめる**。
  （例: `opencode web` の `expose` / `stop` はどちらも `web` 直下の末端コマンドなので、
  `src/opencode/web.rs` に同居する）
- 子サブコマンドが**さらにサブコマンドを持つ（末端でない）場合に限り**、その子を
  ディレクトリ化し、ディレクトリ内へ再帰的に同じ基準を適用する
  （その子の親ファイルはインデックスにする）。

現状の対応は次のとおり。

| ディレクトリ | サブコマンド | ファイル |
|---|---|---|
| `src/git/` | `git repo`（→ `create` / `select`） | `repo.rs` |
| `src/git/` | `git worktree`（→ `select`） | `worktree.rs` |
| `src/opencode/` | `opencode oauth`（→ `setup`） | `oauth.rs` |
| `src/opencode/` | `opencode web`（→ `expose` / `stop`） | `web.rs` |
| `src/tool/` | `tool install` | `install.rs` |
| `src/tool/` | `tool verify` | `verify.rs` |
| `src/tool/` | `tool brew`（→ `upgrade`） | `brew.rs` |
| `src/tool/` | `tool mise`（→ `upgrade`） | `mise.rs` |
| `src/tool/` | `tool bun`（→ `upgrade`） | `bun.rs` |

## 例外

ルール B には次の 2 つの例外を認める。これ以外の非サブコマンドファイルを作らない。

### 例外 1: 共有モジュール（`shared.rs`）

同一グループ内のサブコマンドが共有する基盤コード（型・ヘルパー関数など）は、
サブコマンドではない共有モジュール `shared.rs` に置いてよい。

- 命名は `shared.rs` に統一する。
- スコープはそのグループ内に閉じる（`pub(super)` などでグループ外へ公開しない）。
- 例: `src/tool/shared.rs` は `install` / `verify` / `brew` / `mise` / `bun` が共有する
  `Manifests`・`ToolCommandSpec`・コマンド実行ヘルパーを持つ。

### 例外 2: `cli/` はアプリ基盤＋横断共通ディレクトリ

`src/cli/` はコマンドグループではなく、アプリの外殻と横断共通の置き場とする。
ルール B のサブコマンド分割は適用せず、次のものを置いてよい。

| ファイル | 役割 |
|---|---|
| `src/cli/init.rs` | トップレベルコマンド `init` の実装 |
| `src/cli/launcher.rs` | サブコマンド無しで `mt` を起動したときのランチャー（デフォルト動作） |
| `src/cli/style.rs` | 全モジュールが使う横断共通の表示ヘルパー |

## ルール C: テストコードは本体ファイルから分離する

本体 `.rs` ファイルにはテストコードを書かない。本体ファイルは本体コードに集中させ、
テスト本体は同階層の別ファイルへ分離する。

- **配置と命名**: あるモジュール `foo.rs` のテストは、同階層の `foo.test.rs` に置く。
  （例: `src/tool/shared.rs` のテストは `src/tool/shared.test.rs`）
- **本体側に残すもの**: 本体ファイルには、テスト本体ではなく次の宣言だけを残す。

```rust
#[cfg(test)]
#[path = "foo.test.rs"]
mod tests;
```

- **可視性は変えない**: `*.test.rs` は本体モジュールの子モジュールとしてコンパイルされるため、
  `use super::*;` で本体の private 関数・型を従来どおり参照できる。テストのために
  `pub` 化などの可視性変更をしてはいけない。

### 単体テストと統合テストの区分

- **単体テスト**: 単一モジュール内の処理を検証するテスト。`*.test.rs` に置く。
  このリポジトリのテストは原則すべてこれに該当する。
- **統合テスト**: 複数の公開モジュールにまたがる処理を検証するテストだけを指す。
  Rust 慣習どおり `tests/` ディレクトリに置く。
  - 例: `tests/cli.rs` は `assert_cmd` でビルド済みバイナリを起動する CLI 全体の
    ブラックボックステスト。

## difit の機械可読契約（review-diff ワークフロー向け）

ワークフロー（`chezmoi/dot_tado/workflows/review-diff`）が読み取り経路として
固定名で呼ぶ CLI 契約をここに明記する。実装は `src/difit/threads.rs` と
`src/difit/check.rs`。

### `mt difit start`

difit サーバを起動（実行中なら再利用）してコメントを注入し、stdout JSON の
`url`（`http://localhost:<port>`）でローカルサーバーの URL を提示する。
レビュー表示は URL 提示のみであり、herdr タブ作成・terminal-browser 起動などの
外部表示ツールを呼ばない（ADR-0027）。人間は提示された URL を自分で開く。

### `mt difit threads --json`

`.difit/difit-review.json` の `selection`（base / target / baseMode）に固定して
未 resolve スレッドを `/api/comments-json` から取得し、JSON で出力する
（読み取り専用。サーバ状態・state ファイルを変更せず、stale 復旧もしない）。
state 不在・選択キー未記録・サーバ不応答は明確なエラーで非 0 exit し、
無音で pass しない。`--json` は必須。

```json
{
  "passes": false,
  "selection": {"base": "abc1234", "target": "def5678", "baseMode": "merge-base"},
  "selection_drift": {
    "detection": "detected",
    "expected": {"base": "abc1234", "target": "def5678", "baseMode": "merge-base"},
    "current": {"base": "9999999", "target": "def5678"}
  },
  "threads": [
    {
      "id": "<thread id>",
      "filePath": "src/foo.rs",
      "position": {"side": "new", "line": 12},
      "taxonomy": "issue",
      "blocking": true,
      "body": "<親メッセージ本文（原文）>",
      "author": "User",
      "replies": [{"author": null, "body": "<reply 本文（原文）>"}]
    }
  ],
  "blocking_threads": [
    {
      "id": "<thread id>",
      "file": "src/foo.rs",
      "line": 12,
      "taxonomy": "issue",
      "body": "<親メッセージ本文（原文）>",
      "replies": ["<reply 本文（原文）>"]
    }
  ]
}
```

- `passes`: 未 resolve スレッドがすべてノンブロッキングなら true
- `threads`: 未 resolve スレッド全件。`taxonomy` は `issue` / `question` /
  `context` / `human`、`blocking` は `mt difit check` と同一のゲート分類
  （`src/difit/gate.rs` が唯一の実装）
- `blocking_threads`: `mt difit check` の stdout と同一形状。verdict.json の
  `blocking_threads` にそのまま使える
- `selection`: 読み取りに使った固定選択（direct のとき `baseMode` は省略）
- `selection_drift`: difit サーバが現在返す選択（GET `/api/diff` のみ・read-only）と
  `selection` の比較結果。`detection` は `detected` / `none` / `unavailable` の三値:
  `detected` のとき difit UI での reply / resolve はゲートが読むセッションとは
  別のセッションへ向かう。`none` は probe 成功かつ選択一致。`unavailable` は probe
  失敗（サーバ不応答・契約不一致）でドリフトの有無を判定できず、`current` は null。
  workflow は `unavailable` を fail-closed に扱い、`none`（ドリフトなし）と
  混同しない

使用例: `mt difit threads --json | jq '.blocking_threads'`

### `mt difit resolve <threadId>`

修正済み AI スレッドを、state に固定した選択（`selection`）で resolve する。
エージェント（executor）は `difit comment resolve --port` を直叩きせず、この
コマンドを使う。`difit comment resolve` は選択クエリを持たず、リポジトリ内の
state ファイル由来の port へ無検証で DELETE を送るため、細工された state や
PID 再利用で無関係セッション（別プロジェクトの difit を含む）のスレッドを
不可逆に削除し得る。mt 版は次を 1 コマンドで順に検証する。

1. `.difit/difit-review.json` を fail-closed で読み取る（symlink・`pid <= 0`・
   `port == 0` を拒否。state 不在はエラー）
2. 選択キー（`selection`）が未記録なら resolve しない
3. 記録 pid が記録 port の LISTEN であることを OS 情報で照合し、選択固定の
   取得が成功すること（difit 応答）を確認する
4. 対象スレッドが固定選択の未 resolve スレッドに存在することを確認する
5. 親メッセージの author が `User`（人間）のスレッドは拒否する
   （人間コメントは人間が difit UI で resolve する）
6. 選択固定の `DELETE /api/comments/<threadId>` で resolve する

出力契約: 成功時は `{"resolved":true,"threadId":"<id>"}` を stdout へ出して
exit 0。失敗時（state 不在 / 選択未記録 / 同一性未確認 / 対象が未 resolve
スレッドにない / 人間コメント / HTTP 失敗）は stderr に理由を出して非 0 exit
し、stdout には JSON を出さない（成功と区別できるようにする）。

使用例: `mt difit resolve "$(mt difit threads --json | jq -r '.threads[0].id')"`

### `mt difit check --dry-run`

ゲート判定のみを行い、サーバ停止・状態削除・状態書き換え・
stale 復旧を一切しない。出力 JSON と exit code（通過 0 / ブロック 1）は通常の
`mt difit check` と同一。ワークフローは「dry-run で verdict と非破壊突合 →
一致後に `mt difit done` で後始末」の順序を組める。通常の `mt difit check` は
計画どおり通過時に後始末する。

通常 / `--dry-run` のどちらも、ゲート固定の選択（`state.selection`）と difit
サーバが現在返す選択を比較し（GET `/api/diff` のみ・非破壊）、ドリフトを
検知したら stderr 警告と出力 JSON の `selection_drift`（`mt difit threads --json`
と同一形状）で報告する。`selection_drift` は probe しない `mt difit done` の
出力には含まれない。probe 失敗時は `detection: "unavailable"`（検知不能）として
出力し、`"none"`（ドリフトなし）へ倒さない。

## difit 実バイナリ E2E の検証手順

`src/difit/*.test.rs` の実 difit バイナリ契約テスト（コメント注入・get /
resolve・position 契約・サーバ復旧・選択キー固定・同一性検証など）は、difit が
PATH にない環境では既定で skip する。skip は `MT_REQUIRE_DIFIT` 未設定時の
既定動作で、libtest の出力キャプチャを迂回して実 stderr へ件数つきで報告される
（プロセス終了時に skip 件数を集計して表示する）。

検証を主張する実行（「E2E が通過した」と報告する場合）は strict モードで
skip を失敗に変え、skip 0 件で実行する。

```sh
MT_REQUIRE_DIFIT=1 cargo test
```

- `MT_REQUIRE_DIFIT=1`: difit 不在をテスト失敗にする（strict）
- 未設定・空文字・`0`: difit 不在を skip にし、skip 件数を可視化する

package.json / CI を持たないため、この環境変数が唯一の検証モード切り替えである。
