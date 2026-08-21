---
status: accepted
---

# workflow 型チェック gate と oxlint 運用の明確化

## Context

2026-08-20 の `a448436 style: oxfmt で chezmoi 26ファイル整形 + oxlint 16件修正` が、`chezmoi/dot_cursor/skills/**/workflow.ts` の 5 ファイルで `oxlint` の未使用変数ルール（`argsIgnorePattern: ^_` 相当の暗黙の挙動）により、宣言部（`const _fs = require("node:fs")` / `buildPrompt: (_ctx: PromptCtx)`）だけを `_` 付きにリネームし、使用箇所（`fs.` / `ctx.`）を追従しなかった。結果、`mt-plan-run/workflow.ts` と `mt-deep-research/workflow.ts`（63件）で `Cannot find name 'ctx'` / `Cannot find name 'fs'` の実行時 ReferenceError が発生し、`tado next` で `ctx is not defined` として初めて検出された。

`mise.toml` には `ts-typecheck`（`bunx tsc --noEmit ...`）が存在したが、`lefthook.yml` の `pre-commit`（`ts-lint`/`ts-fmt-check` のみ）にも `pre-push`（`cargo test`/`bun test` のみ）にも配線されておらず、型エラーはどのフックでも止まらなかった。`oxlint` 自体は設定ファイル無し（ゼロコンフィグ）で `--deny-warnings` のみ実行され、退化を検出せず exit 0 で通過した。`ts-typecheck` 全体では `Cannot find module '@opencode-ai/*'` 等の環境起因エラーが 60 件超存在し、素の `tsc` をそのまま gate にすると常時赤になる状態だった。

## Decision

- `pre-push` に `ts-typecheck-gate` を追加する。`pre-commit` は現行（`ts-lint`/`ts-fmt-check`）のまま維持し、重い型チェックは push 時に止めることで `--no-verify` の誘惑を避ける。
- `ts-typecheck` 本体は素の `bunx tsc` 呼び出しのまま残し、gate 用に `scripts/ts-typecheck-gate.sh` ラッパーを新設する。ラッパーは `tsc` 出力を `grep "Cannot find name"` でフィルタし、該当があれば exit 1（ブロッキング）、なければ exit 0（他エラーは警告として stderr に表示）。ブロッキング対象は `Cannot find name` 系のみに限定し、`Cannot find module` 等の環境起因エラーは警告に留める。
- `mise.toml` に `ts-typecheck-gate` タスク（`scripts/ts-typecheck-gate.sh` 呼び出し）を新設し、`lefthook.yml` の `pre-push` から `mise run ts-typecheck-gate` を `env -u GIT_DIR ...` ラップ付きで呼び出す。他タスクと同様に `parallel: true` で並列実行する。
- 既存の退化（`mt-deep-research/workflow.ts` の 63 件を含む 5 workflow の `_ctx` 不整合）は、gate 有効化と同一コミットで修復する。修復は本体で `ctx` を参照している箇所のみ `_ctx` → `ctx` に戻し、未使用の `_ctx` は `_` 付きのまま維持する（`oxlint --deny-warnings` 対応）。
- `oxlint` / `oxfmt` はチェック専用（`--deny-warnings` / `--check`）のまま運用し、自動修正は `mise run ts-fmt` 等の明示的な別タスクで人手実行する。`lefthook` ではチェックのみ走らせる。
- oxlint 設定はゼロコンフィグのまま維持し、`.oxlintrc.json` は新設しない。暗黙の `argsIgnorePattern: ^_` に依存するが、型チェック gate が退化を機械的に止めるため再発は防止できる。

## Consequences

- `ctx` / `fs` 未定義のような実行時 ReferenceError は `pre-push` で機械的にブロックされ、`tado next` まで逃げない。
- `Cannot find module` 等の環境起因エラーは gate をブロックしないため、既存の型エラーが残っていても開発は止まらない。環境起因エラーの解消は別計画で段階的に行える。
- `oxlint --fix` による自動修正が再び宣言だけを壊しても、型チェック gate が push 時に検出する。lint 自体は警告として残るが、実行時破壊は防がれる。
- `scripts/ts-typecheck-gate.sh` の `grep` パターンに依存するため、将来 `Cannot find name` 以外の型エラー（例: `is declared but never used`）をブロッキング対象に含めたい場合はスクリプトの更新が必要。
