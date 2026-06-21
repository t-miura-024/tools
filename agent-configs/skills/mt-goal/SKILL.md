---
name: mt-goal
description: OpenCode 用 `/mt-goal` 条件ベース自律実行機能の概念・条件の書き方・Maker/Checker 分離
---

# mt-goal

`/mt-goal` は、指定した条件が達成されるまでターンを自動継続する OpenCode 用条件ベース自律実行機能です。Claude Code の `/goal` に相当します。

## 概念

- **Goal**: 測定可能な終端状態。`condition` テキストで定義します。
- **Maker/Checker 分離**: 作業は通常モデルが行い、達成判定は `small_model`（安価・高速モデル）が構造化出力 `{ ok, reason }` で行います。
- **Plugin 駆動**: `mt-loop-engine.ts` が `session.idle` イベントで評価を行い、未達なら `reason` を次ターンにフィードバックします。
- **コマンドは状態書き込みのみ**: `/mt-goal` コマンドは `tmp/mt-goal/state.json` を更新するだけで、評価はプラグインが行います。

## 状態ファイル

`tmp/mt-goal/state.json`

```json
{
  "version": 1,
  "goal": {
    "condition": "npm test passes and TypeScript compiles without errors",
    "createdAt": 1718870400000,
    "updatedAt": 1718870400000,
    "turnCount": 3,
    "maxTurns": 100,
    "maxMinutes": 240,
    "startedAt": 1718870400000,
    "lastEvaluation": {
      "ok": false,
      "reason": "2 tests still failing in auth.test.ts",
      "evaluatedAt": 1718870500000
    },
    "cleared": false,
    "clearedAt": null,
    "clearReason": null
  }
}
```

## jq テンプレート

### 初期化

```bash
mkdir -p tmp/mt-goal
echo '{"version": 1, "goal": null}' > tmp/mt-goal/state.json
```

### 設定

```bash
CONDITION="npm test passes"
NOW=$(date +%s)
jq --arg condition "$CONDITION" --argjson now "$NOW" '
  .goal = {
    condition: $condition,
    createdAt: $now * 1000,
    updatedAt: $now * 1000,
    turnCount: 0,
    maxTurns: 100,
    maxMinutes: 240,
    startedAt: $now * 1000,
    lastEvaluation: null,
    cleared: false,
    clearedAt: null,
    clearReason: null
  }
' tmp/mt-goal/state.json > tmp/mt-goal/state.json.tmp && mv tmp/mt-goal/state.json.tmp tmp/mt-goal/state.json
```

### クリア

```bash
NOW=$(date +%s)
jq --argjson now "$NOW" '
  if .goal != null then .goal.cleared = true | .goal.clearedAt = $now * 1000 | .goal.clearReason = "user requested clear" else . end
' tmp/mt-goal/state.json > tmp/mt-goal/state.json.tmp && mv tmp/mt-goal/state.json.tmp tmp/mt-goal/state.json
```

## コマンド

```text
/mt-goal <condition>
/mt-goal status
/mt-goal clear
```

## 良い条件の書き方

### 測定可能

- ✅ `npm test exits with code 0`
- ❌ `make tests pass`（曖昧）

### 証明方法が明確

- ✅ `the file src/agent_config/opencode.rs contains sync_opencode_commands() and cargo test passes`
- ❌ `finish the implementation`

### 制約を含める

- ✅ `all TODOs in tmp/plan/in-progress are resolved or moved to issues, and no must-level review items remain`

## Maker/Checker 分離

- **Maker**: 通常モデルが作業を進めます。
- **Checker**: `small_model` が `{ ok, reason }` を返し、客観的に停止判定します。
- Checker は作業内容を知らないため、条件テキストに必要な証拠を含めてください。

## ハードリミット

- `max-turns`: デフォルト 100
- `max-minutes`: デフォルト 240

リミット到達時は自動的に goal がクリアされ、ユーザーに通知されます。
