---
name: mt-loop
description: OpenCode 用 `/mt-loop`  recurring prompt 機能の概念・状態ファイル・jq 操作テンプレート
---

# mt-loop

`/mt-loop` は、指定したプロンプトを一定間隔で自動注入する OpenCode 用 recurring-prompt 機能です。Claude Code の `/loop` に相当します。

## 概念

- **Loop**: 1 つの定期実行単位。`prompt` と `intervalSeconds` を持ちます。
- **Plugin 駆動**: `mt-loop-engine.ts` が `setInterval(1000)` で tick ループを回し、due になった loop を検出して `client.session.prompt()` で注入します。
- **コマンドは状態書き込みのみ**: `/mt-loop` コマンドは `tmp/mt-loop/state.json` を更新するだけで、実際の駆動はプラグインが行います。

## 状態ファイル

`tmp/mt-loop/state.json`

```json
{
  "version": 1,
  "loops": [
    {
      "id": "loop_1718870400_a1b2c3",
      "prompt": "check CI status and report",
      "intervalSeconds": 300,
      "nextRunAt": 1718870700000,
      "startedAt": 1718870400000,
      "lastRunAt": null,
      "runCount": 0,
      "stopped": false,
      "stoppedAt": null,
      "stopReason": null
    }
  ]
}
```

## jq テンプレート

### 初期化

```bash
mkdir -p tmp/mt-loop
echo '{"version": 1, "loops": []}' > tmp/mt-loop/state.json
```

### 追加（start）

```bash
ID="loop_$(date +%s)_${RANDOM}${RANDOM}"
INTERVAL_SECS=300
NOW=$(date +%s)
jq --arg id "$ID" --arg prompt "check CI status" --argjson interval "$INTERVAL_SECS" --argjson now "$NOW" '
  .loops += [{
    id: $id,
    prompt: $prompt,
    intervalSeconds: $interval,
    nextRunAt: $now * 1000 + ($interval * 1000),
    startedAt: $now * 1000,
    lastRunAt: null,
    runCount: 0,
    stopped: false,
    stoppedAt: null,
    stopReason: null
  }]
' tmp/mt-loop/state.json > tmp/mt-loop/state.json.tmp && mv tmp/mt-loop/state.json.tmp tmp/mt-loop/state.json
```

### 停止（stop）

```bash
ID="loop_1718870400_a1b2c3"
jq --arg id "$ID" '
  .loops |= map(
    if .id == $id and .stopped == false
    then .stopped = true | .stoppedAt = now * 1000 | .stopReason = "user requested stop"
    else . end
  )
' tmp/mt-loop/state.json > tmp/mt-loop/state.json.tmp && mv tmp/mt-loop/state.json.tmp tmp/mt-loop/state.json
```

### 一覧（list）

```bash
jq -r '.loops | map(select(.stopped == false))[] | "\(.id): every \(.intervalSeconds)s, runs=\(.runCount)"' tmp/mt-loop/state.json
```

## コマンド

```text
/mt-loop start <interval> <prompt>
/mt-loop list
/mt-loop stop <id-or-index>
/mt-loop status
```

## 注意

- loop はセッションスコープ。セッションが終了すると注入されません。
- v1 では stopped loop を履歴として保持します（削除はしません）。
- interval の最小値は 1 秒。0 秒が指定された場合は 1 秒に正規化されます。
- メンテナンスプロンプト（`/mt-loop` 引数なし）は v1 では未対応。
