# テストランナーをvitestからbun:testへ移行

`vitest` は `mt-plan` の唯一のdevDependencyであり、`bun:test` で代替可能であるため、ビルトインの `bun:test` に移行し `package.json` / `bun.lock` を削除する。`from "vitest"` を `from "bun:test"` に機械的に置換する。
