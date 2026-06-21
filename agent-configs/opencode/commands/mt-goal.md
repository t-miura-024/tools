---
description: Set, check, and clear /mt-goal condition-based automation
argument-hint: [<condition> | status | clear]
---

<command-instruction>
You are the `/mt-goal` command handler. This command manages a goal condition that the `mt-loop-engine.ts` plugin evaluates on every `session.idle` event.

Allowed forms:
- `/mt-goal <condition>` — set a new goal (replaces any active goal)
- `/mt-goal status` — show the current goal state
- `/mt-goal clear` — clear the active goal

## State file

`tmp/mt-goal/state.json` is the single source of truth. Update it ONLY with `jq` + パイプ + atomic rename. Never edit it by hand.

```bash
GOAL_STATE="tmp/mt-goal/state.json"
```

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

## Set a goal

Arguments: the full condition text after `/mt-goal `.

1. Initialize state file if missing.
2. Write the new goal, resetting counters and clearing previous evaluation.

```bash
CONDITION="$*"
NOW=$(date +%s)
atomic_jq "$GOAL_STATE" \
  --arg condition "$CONDITION" \
  --argjson now "$NOW" \
  '.goal = {
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
  }'
```

Then confirm to the user:
- The condition
- Max turns (100) and max minutes (240) hard limits
- That evaluation happens automatically on each turn end

## Status

Show the current goal state:

```bash
jq -r '
  if .goal == null then "No goal set."
  else
    .goal
    | "Condition: \(.condition)"
      + "\nStatus: \(if .cleared then "CLEARED (\(.clearReason))" else "ACTIVE" end)"
      + "\nTurn: \(.turnCount)/\(.maxTurns)"
      + "\nElapsed: \((now - .startedAt / 1000) / 60 | floor) / \(.maxMinutes) minutes"
      + (if .lastEvaluation then "\nLatest evaluation: ok=\(.lastEvaluation.ok), reason=\(.lastEvaluation.reason)" else "" end)
  end
' "$GOAL_STATE"
```

## Clear

Clear the active goal:

```bash
NOW=$(date +%s)
atomic_jq "$GOAL_STATE" --argjson now "$NOW" '
  if .goal != null then
    .goal.cleared = true
    | .goal.clearedAt = $now * 1000
    | .goal.clearReason = "user requested clear"
  else
    .
  end'
```

Then confirm the goal has been cleared.

## Error handling

- If `tmp/mt-goal/state.json` does not exist, initialize it first:
  ```bash
  mkdir -p tmp/mt-goal
  echo '{"version": 1, "goal": null}' > tmp/mt-goal/state.json
  ```
- If the user invokes `/mt-goal` with no argument and no subcommand, show status.
- If the condition is empty, ask the user to provide one.

## Writing good conditions

Encourage the user to write conditions that are:
- Measurable (e.g., "`npm test` exits with 0")
- Provable from the assistant's own output
- Bounded (the plugin already enforces max-turns/max-minutes)

Example: `/mt-goal npm test passes and all TypeScript errors are resolved`
</command-instruction>

<current-context>
<goal-state>
!`jq -r 'if .goal == null then "No active goal." else "Active goal: \(.goal.condition)" end' tmp/mt-goal/state.json 2>/dev/null || echo "State file not initialized"`
</goal-state>
</current-context>
