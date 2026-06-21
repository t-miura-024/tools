// Source of Truth: agent-configs/opencode/plugins/mt-loop-engine.ts
// Synced to ~/.config/opencode/plugins/mt-loop-engine.ts by `mt agent-config sync`.
// Do not edit the deployed copy directly; edit the Source of Truth and re-sync.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Event, Part, Provider } from "@opencode-ai/sdk";
import type { Model as ModelV2, Provider as ProviderV2 } from "@opencode-ai/sdk/v2";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_NAME = "mt-loop-engine";
const LOOP_STATE_FILE = "tmp/mt-loop/state.json";
const GOAL_STATE_FILE = "tmp/mt-goal/state.json";

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_MINUTES = 240;
const TICK_MS = 1000;

const GOAL_EVAL_MARKER = "[MT_GOAL_EVALUATION]";
const GOAL_FEEDBACK_PREFIX = "[MT_GOAL_FEEDBACK]";

const EVALUATION_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" as const },
      reason: { type: "string" as const },
    },
    required: ["ok", "reason"],
    additionalProperties: false,
  },
};

const CMUX_STATUS_KEY = "mt_loop_status";
const COLOR_LOOP = "#4C8DFF";
const COLOR_GOAL = "#34C759";
const COLOR_ERROR = "#FF3B30";

type Loop = {
  id: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: number;
  startedAt: number;
  lastRunAt: number | null;
  runCount: number;
  stopped: boolean;
  stoppedAt: number | null;
  stopReason: string | null;
};

type LoopState = {
  version: number;
  loops: Loop[];
};

type GoalEvaluation = {
  ok: boolean;
  reason: string;
  evaluatedAt: number;
};

type Goal = {
  condition: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  maxTurns: number;
  maxMinutes: number;
  startedAt: number;
  lastEvaluation: GoalEvaluation | null;
  cleared: boolean;
  clearedAt: number | null;
  clearReason: string | null;
};

type GoalState = {
  version: number;
  goal: Goal | null;
};

type SessionInfo = {
  sessionID: string | null;
  status: "idle" | "busy" | "retry" | null;
};

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveStateFile(directory: string, relPath: string): string {
  return path.resolve(directory, relPath);
}

function atomicWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] Failed to read ${filePath}:`, error);
    return defaultValue;
  }
}

function loadLoopState(directory: string): LoopState {
  return readJson(resolveStateFile(directory, LOOP_STATE_FILE), {
    version: 1,
    loops: [],
  });
}

function saveLoopState(directory: string, state: LoopState): void {
  atomicWrite(resolveStateFile(directory, LOOP_STATE_FILE), state);
}

function loadGoalState(directory: string): GoalState {
  return readJson(resolveStateFile(directory, GOAL_STATE_FILE), {
    version: 1,
    goal: null,
  });
}

function saveGoalState(directory: string, state: GoalState): void {
  atomicWrite(resolveStateFile(directory, GOAL_STATE_FILE), state);
}

function runCmux(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("cmux", args, { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

function setCmuxStatus(label: string, icon: string, color: string): Promise<void> {
  return runCmux([
    "set-status",
    CMUX_STATUS_KEY,
    label,
    "--icon",
    icon,
    "--color",
    color,
  ]);
}

function clearCmuxStatus(): Promise<void> {
  return runCmux(["clear-status", CMUX_STATUS_KEY]);
}

function notifyCmux(subtitle: string, body: string): Promise<void> {
  return runCmux([
    "notify",
    "--title",
    "OpenCode /mt-loop",
    "--subtitle",
    subtitle,
    "--body",
    body,
  ]);
}

function partText(parts: Part[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } & Record<string, unknown> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function parseEvaluation(text: string): { ok: boolean; reason: string } | null {
  try {
    const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.ok === "boolean" && typeof parsed.reason === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function buildDefaultLoopState(): LoopState {
  return { version: 1, loops: [] };
}

function buildDefaultGoalState(): GoalState {
  return { version: 1, goal: null };
}

export const MtLoopEnginePlugin: Plugin = async (input) => {
  const { client, directory } = input;
  const sessionInfo: SessionInfo = { sessionID: null, status: null };
  const smallModels = new Map<string, { providerID: string; modelID: string }>();
  let disposed = false;

  function log(message: string, ...args: unknown[]): void {
    console.log(`[${PLUGIN_NAME}] ${message}`, ...args);
  }

  function warn(message: string, ...args: unknown[]): void {
    console.warn(`[${PLUGIN_NAME}] ${message}`, ...args);
  }

  function error(message: string, ...args: unknown[]): void {
    console.error(`[${PLUGIN_NAME}] ${message}`, ...args);
  }

  async function getEvaluatorModel(): Promise<{ providerID: string; modelID: string } | null> {
    try {
      const response = await client.config.providers({ query: { directory } });
      if (!response.data) {
        return null;
      }
      const { providers, default: defaultMap } = response.data as { providers: Provider[]; default: Record<string, string> };
      if (!providers || providers.length === 0) {
        return null;
      }

      // Determine the default provider from the config's default model mapping.
      let defaultProvider: Provider | undefined;
      for (const provider of providers) {
        if (defaultMap && Object.prototype.hasOwnProperty.call(defaultMap, provider.id)) {
          defaultProvider = provider;
          break;
        }
      }
      if (!defaultProvider) {
        defaultProvider = providers[0];
      }

      // Prefer the default provider's small_model mapping.
      const defaultMapped = smallModels.get(defaultProvider.id);
      if (defaultMapped) {
        return defaultMapped;
      }

      // Fallback: any provider that has a small_model mapping.
      for (const provider of providers) {
        const mapped = smallModels.get(provider.id);
        if (mapped) {
          warn(`Default provider ${defaultProvider.id} has no small_model mapping; using ${provider.id}'s small_model instead`);
          return mapped;
        }
      }

      // Last resort: use the default provider's default model.
      warn("small_model mapping not available; falling back to default model for goal evaluation");
      const defaultModelID = defaultMap?.[defaultProvider.id];
      if (defaultModelID && defaultProvider.models?.[defaultModelID]) {
        return { providerID: defaultProvider.id, modelID: defaultModelID };
      }

      const modelIDs = Object.keys(defaultProvider.models || {});
      if (modelIDs.length > 0) {
        return { providerID: defaultProvider.id, modelID: modelIDs[0] };
      }

      return null;
    } catch (err) {
      error("Failed to resolve evaluator model:", err);
      return null;
    }
  }

  async function injectPrompt(sessionID: string, prompt: string, system?: string): Promise<boolean> {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }],
          ...(system ? { system } : {}),
        },
      });
      return true;
    } catch (err) {
      error(`Failed to inject prompt into session ${sessionID}:`, err);
      return false;
    }
  }

  async function evaluateGoal(sessionID: string, goal: Goal): Promise<GoalEvaluation | null> {
    const model = await getEvaluatorModel();
    if (!model) {
      warn("No model available for goal evaluation; skipping");
      return null;
    }

    const prompt = [
      `${GOAL_EVAL_MARKER}`,
      "You are an unbiased verifier. Evaluate whether the following goal condition is satisfied based on the conversation so far.",
      "",
      `Goal condition: ${goal.condition}`,
      "",
      "Respond ONLY with a JSON object matching this schema: { \"ok\": boolean, \"reason\": string }.",
      "- ok: true if the goal is fully achieved, false otherwise.",
      "- reason: a concise explanation of why it is or is not achieved. If not achieved, include what should be done next.",
      "",
      goal.lastEvaluation
        ? `Previous evaluation (${new Date(goal.lastEvaluation.evaluatedAt).toISOString()}): ok=${goal.lastEvaluation.ok}, reason=${goal.lastEvaluation.reason}`
        : "This is the first evaluation.",
    ].join("\n");

    type PromptBodyWithFormat = {
      model: { providerID: string; modelID: string };
      parts: Array<{ type: "text"; text: string }>;
      system: string;
      format: typeof EVALUATION_SCHEMA;
    };

    try {
      const response = await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          model,
          parts: [{ type: "text", text: prompt }],
          system: `${GOAL_EVAL_MARKER}\nYou must respond with valid JSON only.`,
          // Pass structured output format directly. The v2 SDK/server supports this field even if
          // the v1 TypeScript types do not declare it yet.
          format: EVALUATION_SCHEMA,
        } as PromptBodyWithFormat,
      });

      const text = partText(response.data?.parts || []);
      const parsed = parseEvaluation(text);
      if (!parsed) {
        error("Failed to parse goal evaluation response:", text);
        return null;
      }

      return {
        ok: parsed.ok,
        reason: parsed.reason,
        evaluatedAt: Date.now(),
      };
    } catch (err) {
      error("Goal evaluation prompt failed:", err);
      return null;
    }
  }

  async function checkLoops(): Promise<void> {
    if (!sessionInfo.sessionID || sessionInfo.status !== "idle") {
      return;
    }

    const state = loadLoopState(directory);
    const now = Date.now();
    let changed = false;

    for (const loop of state.loops) {
      if (loop.stopped) {
        continue;
      }
      if (loop.nextRunAt > now) {
        continue;
      }
      if (loop.intervalSeconds <= 0) {
        warn(`Loop ${loop.id} has invalid interval ${loop.intervalSeconds}; stopping it`);
        loop.stopped = true;
        loop.stoppedAt = now;
        loop.stopReason = "invalid interval";
        changed = true;
        continue;
      }

      log(`Running loop ${loop.id} (run #${loop.runCount + 1})`);
      const ok = await injectPrompt(sessionInfo.sessionID, loop.prompt);
      if (!ok) {
        // Do not advance state on injection failure so the loop retries on the next tick.
        continue;
      }

      loop.runCount += 1;
      loop.lastRunAt = now;
      loop.nextRunAt = now + loop.intervalSeconds * 1000;
      changed = true;
    }

    if (changed) {
      saveLoopState(directory, state);
      await updateCmuxStatus();
    }
  }

  async function handleSessionIdle(sessionID: string): Promise<void> {
    const state = loadGoalState(directory);
    if (!state.goal || state.goal.cleared) {
      return;
    }

    const goal = state.goal;
    const now = Date.now();
    // Increment turnCount before evaluation so that failed evaluations still count
    // toward the hard limit and prevent runaway loops.
    goal.turnCount += 1;
    goal.updatedAt = now;

    // Hard limits
    const elapsedMinutes = (now - goal.startedAt) / 1000 / 60;
    if (goal.turnCount > goal.maxTurns) {
      goal.cleared = true;
      goal.clearedAt = now;
      goal.clearReason = `Stopped after exceeding max-turns limit (${goal.maxTurns})`;
      saveGoalState(directory, state);
      await notifyCmux("Goal stopped", `Max turns (${goal.maxTurns}) reached`);
      await updateCmuxStatus();
      return;
    }

    if (elapsedMinutes > goal.maxMinutes) {
      goal.cleared = true;
      goal.clearedAt = now;
      goal.clearReason = `Stopped after exceeding max-minutes limit (${goal.maxMinutes})`;
      saveGoalState(directory, state);
      await notifyCmux("Goal stopped", `Max minutes (${goal.maxMinutes}) reached`);
      await updateCmuxStatus();
      return;
    }

    const evaluation = await evaluateGoal(sessionID, goal);
    if (!evaluation) {
      saveGoalState(directory, state);
      return;
    }

    goal.lastEvaluation = evaluation;

    if (evaluation.ok) {
      goal.cleared = true;
      goal.clearedAt = now;
      goal.clearReason = `Goal achieved: ${evaluation.reason}`;
      saveGoalState(directory, state);
      await notifyCmux("Goal achieved", evaluation.reason);
      await updateCmuxStatus();
      return;
    }

    // Not achieved: inject feedback as the next prompt.
    saveGoalState(directory, state);
    await updateCmuxStatus();

    const feedback = [
      `${GOAL_FEEDBACK_PREFIX}`,
      "The goal has not yet been achieved. Continue working toward it.",
      "",
      `Goal: ${goal.condition}`,
      ``,
      `Verifier feedback: ${evaluation.reason}`,
      `Turn: ${goal.turnCount}/${goal.maxTurns}`,
    ].join("\n");

    await injectPrompt(sessionID, feedback);
  }

  async function updateCmuxStatus(): Promise<void> {
    const loopState = loadLoopState(directory);
    const goalState = loadGoalState(directory);
    const activeLoops = loopState.loops.filter((l) => !l.stopped).length;
    const activeGoal = goalState.goal && !goalState.goal.cleared;

    if (activeGoal && activeLoops > 0) {
      await setCmuxStatus(`Loop+Goal`, "arrow.2.circlepath", COLOR_LOOP);
    } else if (activeGoal) {
      await setCmuxStatus("Goal", "target", COLOR_GOAL);
    } else if (activeLoops > 0) {
      await setCmuxStatus(`Loop ×${activeLoops}`, "arrow.2.circlepath", COLOR_LOOP);
    } else {
      await clearCmuxStatus();
    }
  }

  async function handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "session.status": {
        sessionInfo.sessionID = event.properties.sessionID;
        const status = event.properties.status;
        if (status.type === "busy") {
          sessionInfo.status = "busy";
        } else if (status.type === "retry") {
          sessionInfo.status = "retry";
        } else if (status.type === "idle") {
          sessionInfo.status = "idle";
        } else {
          // Unknown status: treat as busy to stay on the safe side.
          sessionInfo.status = "busy";
        }
        await updateCmuxStatus();
        return;
      }
      case "session.idle": {
        sessionInfo.sessionID = event.properties.sessionID;
        sessionInfo.status = "idle";
        await updateCmuxStatus();
        await handleSessionIdle(event.properties.sessionID);
        return;
      }
      case "session.error": {
        await setCmuxStatus("Loop/Goal Error", "xmark.circle.fill", COLOR_ERROR);
        return;
      }
      default:
        return;
    }
  }

  const tickInterval = setInterval(() => {
    if (disposed) {
      return;
    }
    checkLoops().catch((err) => error("Tick loop error:", err));
  }, TICK_MS);

  return {
    dispose: async () => {
      disposed = true;
      clearInterval(tickInterval);
      await clearCmuxStatus();
    },
    event: async ({ event }: { event: Event }) => {
      await handleEvent(event);
    },
    "experimental.provider.small_model": async (
      input: { provider: ProviderV2 },
      output: { model?: ModelV2 },
    ) => {
      const provider = input.provider;
      const model = output.model;
      if (provider?.id && model?.id) {
        smallModels.set(provider.id, { providerID: provider.id, modelID: model.id });
      }
    },
    "experimental.session.compacting": async (
      _input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const state = loadGoalState(directory);
      if (!state.goal || state.goal.cleared) {
        return;
      }

      const goal = state.goal;
      const lines = [
        "[mt-loop-goal context]",
        `Active goal: ${goal.condition}`,
        `Progress: turn ${goal.turnCount}/${goal.maxTurns}`,
      ];

      if (goal.lastEvaluation) {
        lines.push(`Latest evaluation: ${goal.lastEvaluation.ok ? "ACHIEVED" : "NOT YET"}`);
        lines.push(`Reason: ${goal.lastEvaluation.reason}`);
      } else {
        lines.push("Latest evaluation: (none yet)");
      }

      output.context.push(lines.join("\n"));
    },
  };
};

export default MtLoopEnginePlugin;
