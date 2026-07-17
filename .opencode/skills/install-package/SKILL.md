---
name: install-package
description: 管理されているマニフェスト（manifests/Brewfile / manifests/mise.toml / manifests/bun-global.yml）にパッケージを追記し、既存 Rust 実装の `mt tool install` を実行して Homebrew / Mise / bun のいずれかでインストールする。Homebrew / Mise / bun の各公式リファレンスを WebFetch で照会してツールごとの取扱可否を判定し、ユーザーの公式ドキュメント記載に従って推奨を提示する。「パッケージを入れたい」「ツールを追加して」「〇〇 を Homebrew で入れて」などと言われた時に使用する。
---

# install-package

管理されているマニフェスト（`tools/manifests/` 配下）にパッケージを追記し、既存 Rust 実装の `mt tool install` 経由でインストールまで一気通貫で行う。公式リファレンスを参照してツールごとの取扱可否を判定し、ユーザーに候補を提示した上で安全に追記・実行する。

## 🧠 前提知識

`tools/manifests/` 配下の 3 ファイル（Brewfile / mise.toml / bun-global.yml）が PC ツール管理の Single Source of Truth であり、Homebrew・Mise・bun のインストールは Rust 実装の `mt tool install` が一手に担う。Skill 自体は `brew bundle` / `mise install` / `bun install -g` を直接呼ばない。

- 関連 Skill: mt-search-web（外部ドキュメント参照時のフォールバック）
- 関連 Rust 実装: `src/tool/install.rs`（`mt tool install` の本体）
- 関連プロジェクトドキュメント: `README.md` 「Tool Management」節

## 🏃 ステップ

### 1. 引数 `name` の受け取り

- ユーザーからパッケージ名（例: `fzf`, `node`, `prettier`, `arc`）を受け取る。
- 引数のみで判断できない情報を追加で質問しない。判断と整形は Skill 内部で行う。

### 2. 公式リファレンスの並列照会（WebFetch）

以下の 3 系統を並列で照会し、各ツールで該当パッケージが利用可能かを判定する。

- **Homebrew**: `https://formulae.brew.sh/api/formula/<name>.json`（formula 用）と `https://formulae.brew.sh/api/cask/<name>.json`（cask 用）の両方を試す。200 なら `Homebrew (formula|cask)` の候補として採用。`mas` アプリは `mas search <name>` または `https://itunes.apple.com/search?term=<name>&entity=macSoftware&country=jp` で ID を取得。`vscode` 拡張は `https://marketplace.visualstudio.com/items?itemName=<name>` の存在を確認。
- **Mise**: `https://mise.jdx.dev/dev-tools/` 配下または `mise ls-remote <tool>` の結果から、当該ツールが mise サポート対象かを判定。
- **bun**: `https://registry.npmjs.org/<name>` を GET して 200 なら `bun` の候補として採用（bun global は npm registry からパッケージを取得する）。

### 3. 公式ドキュメントの取得と推奨決定

候補が 1 つ以上見つかった場合、各候補の `homepage` フィールド（formulae / registry のレスポンスから取得）を WebFetch し、公式インストール手順を抽出する。

- 公式ドキュメントに「Homebrew / Mise / bun」のいずれかが明示的に記載されていれば、それを最優先で推奨とする。
- 明示記載がない場合、デフォルト推奨ロジックにフォールバック:
  - CLI ツール・デスクトップアプリ → Homebrew（formula / cask）
  - 言語ランタイム・バージョン管理対象 → Mise
  - npm エコシステムの開発 CLI（biome, prettier, typescript 等） → bun

### 4. ツール候補の提示とユーザー選択

候補一覧を、候補が単一か複数かで通知形式を切り替えて提示する:

- 候補が 1 つのみ: 「唯一の候補なので `<ツール>` に追記して `mt tool install` を実行します」と一文で通知し、ユーザーが明示的にキャンセルしなければ次工程へ。
- 候補が複数: 本文で番号付き選択肢（3 つ）を提示し、ユーザーに選んでもらう。各選択肢に 5 段階の推奨度（★〜★★★★★）と理由を添え、本スキルが定義する推奨ロジック（CLI=Homebrew / runtime=Mise / dev CLI=bun、公式ドキュメント優先）で導出した推奨を 1 番目に置く。

### 5. 既存エントリ検知

ユーザーの選択が確定したら、当該パッケージのエントリを該当マニフェスト（後述）から検索する。

- 既に登録されている場合: 「`<name>` は既に `<manifest>` に登録されています」と通知し、`mt tool install` を実行せず処理を終了する。
- 未登録の場合: 次工程へ進む。
- 検索ルール:
  - 行頭から行末までの文字列マッチで行を比較する（大文字小文字を区別する、Brewfile の `Brewfile` 構文に準ずる）
  - `Brewfile` の `#` で始まるコメント行は対象外とする
  - 同名エントリが複数セクション（例: `brew "fzf"` と `cask "fzf"`）に存在する場合、Step 4 で確定した sub-category のセクションのみを比較対象とする
  - `bun-global.yml` の `#` 始端行も対象外、`空行`も対象外

### 6. マニフェスト追記内容の整形と diff 表示（確認 1 回目 / 種別ごとのセクション末尾追記）

- 種別ごとにセクション末尾に追記行を整形する:
  - `Brewfile`: `tap / brew / cask / mas / vscode / cargo` の各セクションの最後の同種エントリの直後に挿入する。空セクションならセクション行も追加。
    - `brew "<name>"`
    - `cask "<name>"`
    - `mas "<app>", id: <id>`
    - `vscode "<publisher.name>"`
    - `cargo "<name>"`
  - `mise.toml`: `[tools]` セクションの末尾に `<name> = "<version>"` を追記する（`[tools]` がない場合は新規作成）。バージョンは本スキルが定義するルール（明示要求、省略時 `latest`）に従う。
  - `bun-global.yml`: `packages:` セクション内のアルファベット順末尾に `<name>: { version: <version> }` を追記する。`<version>` 省略時は `latest` を使う（明示要求があればそれを優先）。
- 整形後、本文で diff（追記行 + 該当セクション位置）をプレビュー表示し、追記を実行して良いか確認する。

### 7. マニフェストへの追記実行

- ユーザーが確認したら、Edit / Write ツールでマニフェストに追記する。
- ファイル末尾に空改行が無ければ追加して POSIX 準拠の改行を維持する。

### 8. `mt tool install` 実行前の確認（確認 2 回目）

「追記内容: <追記行>」「実行: `mt tool install`」を表示し、ユーザーが明示的に承認するまで `mt tool install` を実行しない。

### 9. `mt tool install` 実行

- 承認後、`mt tool install --help` を Shell ツールで実行し、`mt` バイナリの利用可能性と想定フラグを事前確認する。
- 確認できたら `mt tool install` を Shell ツールで実行する。
- `mt tool install` 自体は `brew` / `mise` / `bun` を子プロセスで呼び出すため、初期は `required_permissions: ["all"]` を付与する。権限不足で失敗した場合は、`src/tool/install.rs` を参照して呼び出している外部コマンドを精査し、必要最小限の権限に縮退する旨をユーザーに提案する。
- 実行中、cleanup プロンプト（既存パッケージ削除候補の確認）が表示される場合がある。これは `mt tool install` の既存挙動なので、Skill から制御せず、ユーザーの対話的判断に委ねる。

### 10. 結果ハンドリング

- 成功時: 追記内容と実行結果をユーザーに報告し、処理を終了する。
- 失敗時: エラー内容を表示し、本文で「追記を保持したまま終了 / `git restore <manifest>` で巻き戻し / 中止」の 3 つの選択肢を番号付きで提示する。
  - 「保持」: 追記を残したままユーザーが手動で再試行・調査できる状態にする。
  - 「巻き戻し」: 該当マニフェストを `git restore` で元の状態に戻す（手動で確認ダイアログを表示）。
  - 「中止」: 追加の操作を行わず処理を終了する。

### 11. エラーケースの分岐

- WebFetch が全 3 系統とも 404 / 失敗: パッケージがどのツールでも見つからなかった旨を通知し、ユーザーに `name` の確認を促す。
- mise.toml が trust されていない: `mt tool install` が失敗するため、`mise trust manifests/mise.toml` をユーザーに案内して終了する。

## ✅ 完了条件

- 候補ツールの一覧が公式リファレンスに基づいて提示されている
- ユーザー選択または自動確定により、対象ツール（Homebrew / Mise / bun）とその sub-category が決定されている
- 既存エントリの重複が検知され、未登録時のみ追記されている
- 追記前に diff が表示され、ユーザーが承認している
- `mt tool install` の実行前にユーザー承認が得られている
- 成功時は追記内容とインストール結果が報告されている
- 失敗時は「保持 / 巻き戻し / 中止」の選択肢が提示されている

## 📦 アウトプット

- 追記されたマニフェストファイル（Brewfile / mise.toml / bun-global.yml のいずれか）
- 追加されたエントリの diff（追記行・追記位置）
- `mt tool install` の実行結果（成功 / 失敗のステータス、失敗時はエラー内容）

## ⚠️ 注意事項

- `brew bundle` / `mise install` / `bun install -g` を Skill から直接呼ばない。必ず `mt tool install` 経由でインストールする（cleanup 制御・`mise exec` 経由の bun 呼び出し・`mise trust` 確認などの既存実装を活用する）
- WebFetch は冪等でない（公式リファレンスの更新）ため、結果はキャッシュせず毎回取得する
- `mas` の app ID は WebFetch で取得できない場合がある（`mas search` も候補）。両方失敗したらユーザーに ID の直接入力を求める
- 候補が 0 件の場合、Skill は終了し、ユーザーに `name` の確認を促す（パッケージマネージャ側で見つからないという事実だけ報告し、別の `name` を試すよう促す）
- `mise.toml` の trust が切れているケースは `mt tool install` 側で必ず失敗するため、ユーザーへの案内は `mise trust manifests/mise.toml` の 1 行で十分
- 公式ドキュメントの言語は英語が主。WebFetch 結果にインストール手順が複数言語で記載されている場合、`Homebrew` / `Brew` / `mise` / `bun` いずれかの言及があるかを単純な文字列マッチで判定する
