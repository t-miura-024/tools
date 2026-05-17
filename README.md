# @mt/tools

個人開発支援用の CLI ツール・スクリプト集。

## Prerequisites

- Node.js >= 26
- pnpm

## Setup

```bash
pnpm install
```

## Scripts

| Command             | Description                  |
| ------------------- | ---------------------------- |
| `pnpm lint`         | oxlint で静的解析            |
| `pnpm format`       | oxfmt でコードフォーマット   |
| `pnpm format:check` | フォーマットチェックのみ     |
| `pnpm typecheck`    | TypeScript 型チェック        |
| `pnpm test`         | vitest でテスト実行          |
| `pnpm test:watch`   | vitest を watch モードで実行 |

## Project Structure

```
src/
  git/          # Git 関連のスクリプト
```

## Adding a New Script

1. `src/<category>/<name>.ts` にスクリプトを作成
2. 必要に応じて `<name>.test.ts` にテストを追加
3. `pnpm typecheck && pnpm test` で動作確認

## Tech Stack

| Tool                                                      | Purpose                 |
| --------------------------------------------------------- | ----------------------- |
| [TypeScript](https://www.typescriptlang.org/)             | 言語                    |
| [tsx](https://tsx.is/)                                    | TypeScript 実行ランナー |
| [oxlint](https://oxc.rs/)                                 | Linter                  |
| [oxfmt](https://oxc.rs/)                                  | Formatter               |
| [vitest](https://vitest.dev/)                             | テストフレームワーク    |
| [commander](https://github.com/tj/commander.js)           | CLI 引数パース          |
| [consola](https://github.com/unjs/consola)                | ロガー                  |
| [execa](https://github.com/sindresorhus/execa)            | 外部コマンド実行        |
| [fs-extra](https://github.com/jprichardson/node-fs-extra) | ファイル操作            |
| [globby](https://github.com/sindresorhus/globby)          | ファイルグロブ          |
| [pathe](https://github.com/unjs/pathe)                    | パス操作ユーティリティ  |
