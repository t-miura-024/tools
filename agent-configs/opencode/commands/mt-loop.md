---
description: Register, list, stop, and check /mt-loop recurring prompts
argument-hint: <start <interval> <prompt> | list | stop <id> | status>
---

<command-instruction>
You are the `/mt-loop` command handler. This command manages recurring prompts that the `mt-loop-engine.ts` plugin injects into the current session.

Allowed subcommands:
- `start <interval> <prompt>` — register a new loop
- `list` — show active (non-stopped) loops
- `stop <id>` — stop a loop by ID or index
- `status` — show loop engine status

## User input

The user's arguments (the text after `/mt-loop `) are provided in the `<user-arguments>` section of `<current-context>` below. Parse the subcommand from the first token and the remaining arguments from the rest.

## State file

`tmp/mt-loop/state.json` is the single source of truth. Update it ONLY with `jq` + パイプ + atomic rename. Never edit it by hand.

```bash
LOOP_STATE="tmp/mt-loop/state.json"
```

## Helpers

### Parse interval

`<interval>` accepts a number optionally suffixed by `s`, `m`, `h`, `d`:
- `30s` → 30 seconds
- `5m` → 300 seconds
- `1h` → 3600 seconds
- `1d` → 86400 seconds

Plain number is treated as seconds.

### Atomic write

```bash
atomic_jq() {
  local target="$1"
  shift
  local tmp="${target}.tmp.$$"
  if jq "$@" "$target" > "$tmp"; then
    mv "$tmp" "$target"
  else
    rm -f "$tmp"
    echo "Failed to update $target" >&2
    exit 1
  fi
}
```

## start

Arguments: `start <interval> <prompt>`

1. Compute `intervalSeconds` from `<interval>`. Minimum is 1 second.
2. Generate a loop ID: `loop_<timestamp>_<random>`.
3. Append the loop to `tmp/mt-loop/state.json`.

```bash
ID="loop_$(date +%s)_${RANDOM}${RANDOM}"
INTERVAL_SECS=$(jq -nR '
  . as $raw
  | ($raw | capture("^(?<n>[0-9]+)(?<unit>[smhd]?)$"))
  | (.n | tonumber) as $num
  | if .unit == "s" or .unit == "" then $num
    elif .unit == "m" then $num * 60
    elif .unit == "h" then $num * 3600
    elif .unit == "d" then $num * 86400
    else $num end
  | if . < 1 then 1 else . end
' <<<"$INTERVAL")
if [[ "$INTERVAL_SECS" -lt 1 ]]; then
  INTERVAL_SECS=1
fi
NOW=$(date +%s)
atomic_jq "$LOOP_STATE" \
  --arg id "$ID" \
  --arg prompt "$PROMPT" \
  --argjson interval "$INTERVAL_SECS" \
  --argjson now "$NOW" \
  '.loops += [{
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
  }]'
```

Then report the new loop ID and next run time.

## list

Show active loops (non-stopped). Use jq to filter and format.

```bash
jq -r '
  .loops
  | map(select(.stopped == false))
  | to_entries[]
  | "\(.key + 1). \(.value.id) | every \(.value.intervalSeconds)s | next: \(if .value.nextRunAt then (.value.nextRunAt / 1000 | strftime("%Y-%m-%d %H:%M:%S")) else "now" end) | runs: \(.value.runCount)"
' "$LOOP_STATE"
```

If empty, say "No active loops."

## stop

Arguments: `stop <id-or-index>`

`<id-or-index>` can be:
- Full loop ID (e.g., `loop_1718870400_a1b2c3`)
- 1-based index from `list`

```bash
TARGET="$1"

# Resolve index to ID if needed
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  ID=$(jq -r --argjson idx "$TARGET" '
    [.loops[] | select(.stopped == false)][$idx - 1].id // empty
  ' "$LOOP_STATE")
  if [[ -z "$ID" ]]; then
    echo "No active loop at index $TARGET"
    exit 1
  fi
else
  ID="$TARGET"
fi

atomic_jq "$LOOP_STATE" --arg id "$ID" '
  .loops |= map(
    if .id == $id and .stopped == false
    then .stopped = true | .stoppedAt = now * 1000 | .stopReason = "user requested stop"
    else . end
  )'
```

After stopping, report the stopped loop ID.

## status

Show a concise summary:

```bash
jq -r '
  {
    total: (.loops | length),
    active: (.loops | map(select(.stopped == false)) | length),
    stopped: (.loops | map(select(.stopped == true)) | length)
  }
  | "Loops: total=\(.total), active=\(.active), stopped=\(.stopped)"
' "$LOOP_STATE"
```

## Error handling

- If the subcommand is unknown, list the allowed subcommands.
- If `tmp/mt-loop/state.json` does not exist, initialize it first:
  ```bash
  mkdir -p tmp/mt-loop
  echo '{"version": 1, "loops": []}' > tmp/mt-loop/state.json
  ```
- Never delete stopped loops from state.json in v1 (keep them for visibility).
</command-instruction>

<current-context>
<loop-state>
!`jq -r '.loops | map(select(.stopped == false)) | length as $c | "Active loops: \($c)"' tmp/mt-loop/state.json 2>/dev/null || echo "State file not initialized"`
</loop-state>
<user-arguments>
$ARGUMENTS
</user-arguments>
</current-context>
