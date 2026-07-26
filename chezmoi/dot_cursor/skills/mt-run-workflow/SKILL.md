---
name: mt-run-workflow
description: ワークフローエンジン（mt-workflow cli.ts）を起動し、init → next/report サイクルでワークフローを進行させる汎用ランナー。各ワークフロー Skill の薄い SKILL.md から --workflow <workflow.ts パス> 付きで起動される。ワークフロー固有のロジックは一切持たない。
---

# mt-run-workflow

ワークフローエンジン（`mt-workflow` の `cli.ts`）を起動し、`next` / `report` サイクルでワークフローを進行させる**汎用ランナー**です。

本 Skill はエンジン起動の通用手順を 1 箇所に集約したものであり、純粋なランナーです。ワークフロー固有のロジック（完了条件・注意事項・共有資材パス・ステップ固有の指示）は一切持ちません。それらはすべて起動対象の `workflow.ts` のステッププロンプト内に含まれており、`next` が返す完全なプロンプトに従うだけで進行できます。

## 入力

起動元の Skill から `--workflow <workflow.ts パス>` が渡される。以下の手順の `<workflow.ts パス>` をその値に置き換えて使用する。

## 手順

### 1. セッション初期化（init）

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts init \
  --workflow <workflow.ts パス>
```

- stdout にセッション情報（`sessionId` を含む JSON）が出力される。`sessionId` を控え、以降のコマンドの `<id>` に使う。
- 状態は `workflow.db`（SQLite）で機械的に管理される。

### 2. next / report サイクル

`init` 後は、`next`（次のステップのプロンプト取得）→ ステップ実行 → `report`（結果報告）のサイクルで進行する。

```bash
# 次のステップのプロンプトを取得
bun run ~/.config/opencode/skills/mt-workflow/cli.ts next --session <id>
```

`next` は現在のステップの**完全なプロンプト**を stdout に JSON で返す。返却された `prompt` と `action` に従ってステップを実行する。プロンプトは完全であり、LLM が手順を再構築・補完する余地はない。ワークフロー固有の指示もすべてこのプロンプトに含まれる。

ステップ完了後、結果を stdin の JSON で `report` に渡す:

```bash
echo '{"stepKey":"...","status":"completed","subagentOutput":"..."}' | \
  bun run ~/.config/opencode/skills/mt-workflow/cli.ts report --session <id>
```

`report` は完了検証・状態遷移・リトライ判定を行い、次の状態を返す。`next` → 実行 → `report` を、ワークフローが完了するまで繰り返す。

### 3. 状態確認（status）

必要に応じて現在状態を確認できる。

```bash
bun run ~/.config/opencode/skills/mt-workflow/cli.ts status --session <id>
```

## 注意事項

- 本 Skill はエンジン起動手順の集約であり、ワークフロー固有の判断は行わない。固有の指示は `next` が返すプロンプトに従う。
- `next` が返すプロンプトは完全。手順を抜かしたり簡略化したりしない。
- コマンド仕様・返却 JSON の詳細スキーマ（task / human_gate / parallel 各形式）・ワークフロー定義の作成方法は `mt-workflow` Skill を参照。本 Skill はそれらを重複して持たない。
