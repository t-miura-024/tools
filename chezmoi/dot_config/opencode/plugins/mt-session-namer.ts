// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/mt-session-namer.ts
//
// Dynamically renames root sessions based on conversation content.
import type { Event, Provider, Session } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";

const TEMP_TITLE = "session-namer-temp";
const THROTTLE_MS = 60_000;
const MAX_LLM_CALLS = 3;
const DEFAULT_MAX_LENGTH = 60;
const MODEL_PATTERNS = [/free/i, /flash/i, /lite/i];
const ENV_MODEL = process.env.OPENCODE_SESSION_NAMER_MODEL;
const ENV_MAX_LENGTH =
  Number(process.env.OPENCODE_SESSION_NAMER_MAX_LENGTH) ||
  DEFAULT_MAX_LENGTH;
const ENV_DISABLED =
  process.env.OPENCODE_SESSION_NAMER_DISABLED === "1" ||
  process.env.OPENCODE_SESSION_NAMER_DISABLED === "true";
const ENV_DEBUG =
  process.env.OPENCODE_SESSION_NAMER_DEBUG === "1" ||
  process.env.OPENCODE_SESSION_NAMER_DEBUG === "true";

type SessionInfo = Pick<
  Session,
  "id" | "title" | "directory" | "projectID" | "parentID"
>;

type QueueTask = () => Promise<void>;

function enqueue(
  queue: { current: Promise<void> },
  task: QueueTask,
): Promise<void> {
  const next = queue.current.then(task, task);
  queue.current = next.catch(() => {});
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]$/, "");
}

function isDefaultTitle(title: string | undefined): boolean {
  if (!title) return true;
  return /^New session - /.test(title) || /^Child session - /.test(title);
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeTitle(title: string, maxLength: number): string {
  return title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function textOf(parts: Array<{ type: string; text?: string }>): string {
  for (const part of parts) {
    if (part.type === "text" && part.text) return part.text;
  }
  return "";
}

function sessionFromInfo(value: unknown): SessionInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const session = value as Partial<SessionInfo>;
  if (
    typeof session.id !== "string" ||
    typeof session.title !== "string" ||
    typeof session.directory !== "string" ||
    typeof session.projectID !== "string"
  ) {
    return undefined;
  }
  return session as SessionInfo;
}

function cheapModelID(models: Provider["models"] | undefined): string | null {
  const modelIDs = Object.keys(models ?? {});
  for (const pattern of MODEL_PATTERNS) {
    const match = modelIDs.find((id) => pattern.test(id));
    if (match) return match;
  }
  return modelIDs[0] ?? null;
}

export const SessionNamer: Plugin = async ({ client, project, directory }) => {
  const queue = { current: Promise.resolve() };
  const sessions = new Map<string, SessionInfo>();
  const lastSetTitles = new Map<string, string>();
  const manualSessions = new Set<string>();
  const assistantSeen = new Set<string>();
  const lastEvaluationAt = new Map<string, number>();
  const llmCallCounts = new Map<string, number>();
  const pending = new Set<string>();
  const tempSessions = new Set<string>();
  let resolvedModel: { providerID: string; modelID: string } | null | undefined =
    null;

  if (ENV_DISABLED) return {};

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => {
    if (level === "debug" && !ENV_DEBUG) return;
    client.app
      .log({
        body: { service: "session-namer", level, message },
      })
      .catch(() => {});
  };

  function isCurrentProject(session: SessionInfo): boolean {
    return (
      session.projectID === project.id &&
      normalizePath(session.directory) === normalizePath(directory)
    );
  }

  async function ensureSession(
    sessionID: string,
  ): Promise<SessionInfo | undefined> {
    const cached = sessions.get(sessionID);
    if (cached) return cached;
    try {
      const response = await client.session.get({ path: { id: sessionID } });
      const info = sessionFromInfo(response.data);
      if (info) sessions.set(sessionID, info);
      return info;
    } catch (error) {
      log("warn", `session lookup failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async function loadSessions(): Promise<void> {
    try {
      const response = await client.session.list();
      for (const session of response.data ?? []) {
        if (session.parentID || !isCurrentProject(session)) continue;
        sessions.set(session.id, session);
        lastSetTitles.set(session.id, session.title);
      }
      log("info", `seeded ${sessions.size} sessions`);
    } catch (error) {
      log("warn", `session list failed: ${errorMessage(error)}`);
    }
  }

  async function findModel(): Promise<{
    providerID: string;
    modelID: string;
  } | null> {
    try {
      const providerResponse = await client.config.providers();
      const providers = providerResponse.data?.providers ?? [];
      if (ENV_MODEL) {
        if (ENV_MODEL.includes("/")) {
          const [providerID, modelID] = ENV_MODEL.split("/", 2);
          return { providerID, modelID };
        }
        for (const provider of providers) {
          if (ENV_MODEL in (provider.models ?? {})) {
            return { providerID: provider.id, modelID: ENV_MODEL };
          }
        }
        log("warn", `model not found in any provider: ${ENV_MODEL}`);
        return null;
      }
      let connected: string[] = [];
      try {
        const listResponse = await client.provider.list();
        connected = listResponse.data?.connected ?? [];
      } catch (error) {
        log("debug", `provider list failed: ${errorMessage(error)}`);
      }
      const sorted = [
        ...providers.filter((p) => connected.includes(p.id)),
        ...providers.filter((p) => !connected.includes(p.id)),
      ];
      for (const provider of sorted) {
        const modelID = cheapModelID(provider.models);
        if (modelID) {
          log("info", `selected model: ${provider.id}/${modelID}`);
          return { providerID: provider.id, modelID };
        }
      }
      log("warn", "no usable model found");
    } catch (error) {
      log("warn", `provider lookup failed: ${errorMessage(error)}`);
    }
    return null;
  }

  async function resolveModel(): Promise<{
    providerID: string;
    modelID: string;
  } | undefined> {
    if (resolvedModel !== null) return resolvedModel;
    resolvedModel = (await findModel()) ?? undefined;
    return resolvedModel;
  }

  async function getConversation(sessionID: string): Promise<{
    firstUser: string;
    latestUser: string;
    firstAssistant: string;
    latestAssistant: string;
  }> {
    const empty = {
      firstUser: "",
      latestUser: "",
      firstAssistant: "",
      latestAssistant: "",
    };
    try {
      const response = await client.session.messages({
        path: { id: sessionID },
      });
      const result = { ...empty };
      for (const entry of response.data ?? []) {
        const text = textOf(entry.parts);
        if (!text) continue;
        if (entry.info.role === "user") {
          if (!result.firstUser) result.firstUser = text;
          result.latestUser = text;
        } else if (entry.info.role === "assistant") {
          if (!result.firstAssistant) result.firstAssistant = text;
          result.latestAssistant = text;
        }
      }
      return result;
    } catch (error) {
      log("warn", `message fetch failed: ${errorMessage(error)}`);
      return empty;
    }
  }

  async function generateTitle(
    sessionID: string,
    conversation: {
      firstUser: string;
      latestUser: string;
      firstAssistant: string;
      latestAssistant: string;
    },
    model: { providerID: string; modelID: string },
  ): Promise<string | null> {
    const context: string[] = [];
    if (conversation.firstUser) {
      context.push(`First user message: "${conversation.firstUser.slice(0, 300)}"`);
    }
    if (
      conversation.latestUser &&
      conversation.latestUser !== conversation.firstUser
    ) {
      context.push(`Latest user message: "${conversation.latestUser.slice(0, 300)}"`);
    }
    if (conversation.firstAssistant) {
      context.push(
        `First assistant response: "${conversation.firstAssistant.slice(0, 400)}"`,
      );
    }
    if (
      conversation.latestAssistant &&
      conversation.latestAssistant !== conversation.firstAssistant
    ) {
      context.push(
        `Latest assistant response: "${conversation.latestAssistant.slice(0, 400)}"`,
      );
    }
    const prompt = [
      "Generate a concise, specific title for this conversation:",
      "",
      ...context,
      "",
      "Rules:",
      `- MUST NOT exceed ${ENV_MAX_LENGTH} characters - this is a hard limit`,
      "- Use the language of the conversation",
      "- Be SPECIFIC about the actual content discussed",
      '- If a plan or issue reference appears (e.g., "Plan #25", "Issue #123"), include it as a prefix (e.g., "Plan #25: Fix login bug")',
      "- Return ONLY the title, nothing else",
    ].join("\n");

    let tempID: string | null = null;
    try {
      const created = await client.session.create({
        body: { parentID: sessionID, title: TEMP_TITLE },
      });
      tempID = created.data?.id ?? null;
      if (!tempID) return null;
      tempSessions.add(tempID);
      const response = await client.session.prompt({
        path: { id: tempID },
        body: {
          parts: [{ type: "text", text: prompt }],
          model: { providerID: model.providerID, modelID: model.modelID },
        },
      });
      const text = textOf(response.data?.parts ?? []);
      const firstLine =
        text
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "";
      const title = sanitizeTitle(firstLine || text, ENV_MAX_LENGTH);
      return title.length > 0 ? title : null;
    } catch (error) {
      log("warn", `title generation failed: ${errorMessage(error)}`);
      return null;
    } finally {
      if (tempID) {
        tempSessions.delete(tempID);
        await client.session.delete({ path: { id: tempID } }).catch(() => {});
      }
    }
  }

  async function evaluate(sessionID: string): Promise<void> {
    if (manualSessions.has(sessionID) || pending.has(sessionID)) return;
    const info = await ensureSession(sessionID);
    if (
      !info ||
      info.parentID ||
      tempSessions.has(sessionID) ||
      !isCurrentProject(info)
    ) {
      return;
    }

    const lastSet = lastSetTitles.get(sessionID);
    if (lastSet !== undefined) {
      if (info.title !== lastSet) {
        manualSessions.add(sessionID);
        log("info", `manual title detected, freezing session: ${sessionID}`);
        return;
      }
    } else if (!isDefaultTitle(info.title)) {
      manualSessions.add(sessionID);
      log("info", `existing custom title, freezing session: ${sessionID}`);
      return;
    }

    const now = Date.now();
    if (
      assistantSeen.has(sessionID) &&
      now - (lastEvaluationAt.get(sessionID) ?? 0) < THROTTLE_MS
    ) {
      return;
    }

    const conversation = await getConversation(sessionID);
    const primary = conversation.firstUser || conversation.latestUser;
    if (!primary) return;
    const hasAssistant =
      conversation.firstAssistant !== "" ||
      conversation.latestAssistant !== "";
    if (hasAssistant) assistantSeen.add(sessionID);

    let title: string | null = null;
    if (hasAssistant) {
      const calls = llmCallCounts.get(sessionID) ?? 0;
      if (calls >= MAX_LLM_CALLS) {
        if (calls === MAX_LLM_CALLS) {
          log("info", `llm title limit reached, freezing session: ${sessionID}`);
        }
        return;
      }
      if (now - (lastEvaluationAt.get(sessionID) ?? 0) < THROTTLE_MS) return;
      lastEvaluationAt.set(sessionID, now);
      pending.add(sessionID);
      try {
        const model = await resolveModel();
        if (model) {
          llmCallCounts.set(sessionID, calls + 1);
          title = await generateTitle(sessionID, conversation, model);
        }
      } finally {
        pending.delete(sessionID);
      }
    }

    if (!title) title = sanitizeTitle(primary, ENV_MAX_LENGTH);
    if (!title) return;

    if (normalizeTitle(info.title) === normalizeTitle(title)) {
      lastSetTitles.set(sessionID, info.title);
      return;
    }

    try {
      await client.session.update({
        path: { id: sessionID },
        body: { title },
      });
      lastSetTitles.set(sessionID, title);
      log("info", `renamed session ${sessionID}: ${title}`);
    } catch (error) {
      log("warn", `title update failed: ${errorMessage(error)}`);
    }
  }

  async function handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = sessionFromInfo(event.properties.info);
        if (!info) return;
        sessions.set(info.id, info);
        if (
          !info.parentID &&
          isCurrentProject(info) &&
          !lastSetTitles.has(info.id)
        ) {
          lastSetTitles.set(info.id, info.title);
        }
        return;
      }
      case "session.deleted": {
        const info = sessionFromInfo(event.properties.info);
        if (!info) return;
        sessions.delete(info.id);
        lastSetTitles.delete(info.id);
        manualSessions.delete(info.id);
        assistantSeen.delete(info.id);
        lastEvaluationAt.delete(info.id);
        llmCallCounts.delete(info.id);
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        if (part.type !== "text" || !part.text) return;
        await evaluate(part.sessionID);
        return;
      }
      default:
        return;
    }
  }

  enqueue(queue, loadSessions);
  log("info", "session namer initialized");

  return {
    event: async ({ event }: { event: Event }) => {
      await enqueue(queue, async () => {
        try {
          await handleEvent(event);
        } catch (error) {
          log("error", `event handling failed: ${errorMessage(error)}`);
        }
      });
    },
    dispose: async () => {},
  };
};

export default SessionNamer;
