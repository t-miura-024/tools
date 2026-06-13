# agent-configs/opencode/

opencode 固有の設定ファイル置き場。`mt agent-config sync` で `~/.config/opencode/` 配下へ同期される。

`agents/`、`skills/`、`AGENTS.md` はプラットフォーム間で共有されるため、引き続き `agent-configs/` 直下に置く。opencode だけで使うファイル（プラグイン、独自設定など）はこのディレクトリ以下に配置する。

## plugins/

`~/.config/opencode/plugins/` へデプロイされる TypeScript プラグイン。opencode はこのディレクトリに配置されたプラグインを起動時に自動ロードする。

- `cmux-notify.ts` — cmux にセッション状態の変化を通知し、サイドバータブに status バッジを出すプラグイン。`session.status` / `session.idle` / `session.error` / `permission.updated` の各イベントで `cmux notify` / `cmux set-status` / `cmux clear-status` を呼び出す。`cmux` バイナリが PATH にない場合は no-op で安全。

  バッジ対応:
  - `busy` → ⚡️ bolt.fill (青) "Running"
  - `retry` → ↻ arrow.clockwise (橙) "Retrying"
  - `error` → ❌ xmark.circle.fill (赤) "Error"
  - `idle` / その他 → バッジクリア

## 同期ルール

- `sync.rs` の opencode 用 sync は `additive 同期` を行う。`plugins/` 配下の Source of Truth に存在しないファイル（ユーザが個別にインストールしたプラグイン）は削除しない。
- `mt agent-config hook --check` が `~/.config/opencode/plugins/` への直接編集をブロックする。プラグインの追加・変更は必ず Source of Truth 側で行い、`mt agent-config sync` で反映する。
