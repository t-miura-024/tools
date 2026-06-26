# agent-configs/opencode/

opencode 固有の設定ファイル置き場。`mt agent-config sync` で `~/.config/opencode/` 配下へ同期される。

`agents/`、`skills/`、`AGENTS.md` はプラットフォーム間で共有されるため、引き続き `agent-configs/` 直下に置く。opencode だけで使うファイル（プラグイン、独自設定など）はこのディレクトリ以下に配置する。

## plugins/

`~/.config/opencode/plugins/` へデプロイされる TypeScript プラグイン。opencode はこのディレクトリに配置されたプラグインを起動時に自動ロードする。

- `cmux-notify.ts` — cmux にセッション状態の変化を通知し、サイドバータブに status バッジを出すプラグイン。`session.status` / `session.idle` / `session.error` / `permission.updated` の各イベントで `cmux set-status` / `cmux clear-status` を呼び出し、メインセッション（`parentID` を持たないセッション）のときだけ `cmux notify` を発火する。`cmux` バイナリが PATH にない場合は no-op で安全。

  OS 通知（"Task complete" / "Error" / "Waiting for input"）は `client.session.get` で取得したセッションに `parentID` が無い場合（= メインセッション）にのみ実行する。サブエージェント由来のものではサイドバーの status バッジ更新と workspace カラーのみ更新し、OS 通知は発火しない。`session.error` で `sessionID` が付与されていないケースでも OS 通知はスキップする。

  ステータス更新のたびに `process.cwd()` で `git diff --shortstat` を実行し、ラベル末尾に ` (+<ins> -<del>)` の差分サマリを付与する（`wt` コマンドと同じ書式）。git 管理外のディレクトリでは差分表示を省略。

  バッジ対応:
  - `busy` → ⚡️ bolt.fill (青) "Running (+N -N)"
  - `retry` → ↻ arrow.clockwise (橙) "Retrying (+N -N)"
  - `error` → ❌ xmark.circle.fill (赤) "Error (+N -N)"
  - `idle` / その他 → ✅ checkmark.circle.fill (緑) "Idle (+N -N)" / 終了時にバッジクリア

- `mt-loop-engine.ts` — `/mt-loop`・`/mt-goal` の駆動・評価・注入プラグイン。`setInterval(1000)` の tick ループで `tmp/mt-loop/state.json` を監視し、`session.idle` イベントで `tmp/mt-goal/state.json` の条件達成評価を行う。`cmux` 連携でループ/ゴールの実行中状態をサイドバーに表示する。

## commands/

`~/.config/opencode/commands/` へデプロイされるスラッシュコマンド定義。Markdown ファイルの frontmatter + `<command-instruction>` ブロックで定義する。

- `mt-loop.md` — `/mt-loop` コマンド。ループの登録・一覧・停止・状態確認。
- `mt-goal.md` — `/mt-goal` コマンド。ゴールの設定・状態確認・クリア。

## 同期ルール

- `sync.rs` の opencode 用 sync は `additive 同期` を行う。`plugins/` および `commands/` 配下の Source of Truth に存在しないファイル（ユーザが個別にインストールしたプラグイン/コマンド）は削除しない。
- `mt agent-config hook --check` が `~/.config/opencode/plugins/` および `~/.config/opencode/commands/` への直接編集をブロックする。プラグイン/コマンドの追加・変更は必ず Source of Truth 側で行い、`mt agent-config sync` で反映する。
