// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/mt-session-namer.ts
//
// Dynamically renames root sessions based on conversation content.
//
// NOTE: このファイルは default エクスポート（Plugin.define の結果）のみを持つこと。
// opencode のローダーはこの形式を要求し、他の値エクスポートがあると
// ロード全体が失敗する。純粋ロジックは ../lib/mt-session-namer.ts に置く。
//
// V2 制約: プラグイン API に session.list / session.remove がないため、
// 起動時の既存セッションはシードできず、イベント経由で遅延追跡する。
// タイトル生成は一時セッションではなく ctx.generate.text を使う。
import { Plugin } from "@opencode-ai/plugin";
import { orderModelIDs } from "../lib/mt-session-namer";

const THROTTLE_MS = 60_000;
const MAX_LLM_CALLS = 3;
const DEFAULT_MAX_LENGTH = 60;
const ENV_MODEL = process.env.OPENCODE_SESSION_NAMER_MODEL;
const ENV_MAX_LENGTH = Number(process.env.OPENCODE_SESSION_NAMER_MAX_LENGTH) || DEFAULT_MAX_LENGTH;
const ENV_DISABLED =
  process.env.OPENCODE_SESSION_NAMER_DISABLED === "1" ||
  process.env.OPENCODE_SESSION_NAMER_DISABLED === "true";
const ENV_DEBUG =
  process.env.OPENCODE_SESSION_NAMER_DEBUG === "1" ||
  process.env.OPENCODE_SESSION_NAMER_DEBUG === "true";

type GenerateClient = Plugin.Context["generate"];

type CachedSession = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
  parentID?: string;
};

type QueueTask = () => Promise<void>;

type ModelCandidate = {
  providerID: string;
  modelID: string;
};

type Conversation = {
  firstUser: string;
  latestUser: string;
  firstAssistant: string;
  latestAssistant: string;
  providerID: string | null;
};

function enqueue(queue: { current: Promise<void> }, task: QueueTask): Promise<void> {
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
  return title.startsWith("New session - ") || title.startsWith("Child session - ");
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeTitle(title: string, maxLength: number): string {
  return (
    title
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

function messageText(message: {
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}): string {
  if (message.type === "user" && typeof message.text === "string") {
    return message.text;
  }
  if (message.type === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text" && part.text) return part.text;
    }
  }
  return "";
}

function messageProviderID(message: {
  type: string;
  model?: { providerID?: string };
}): string | null {
  if (message.type === "assistant" && typeof message.model?.providerID === "string") {
    return message.model.providerID;
  }
  return null;
}

export default Plugin.define({
  id: "mt-session-namer",
  setup(ctx) {
    if (ENV_DISABLED) return;

    const projectID = ctx.location.project.id;
    const directory = ctx.location.directory;
    const queue = { current: Promise.resolve() };
    const sessions = new Map<string, CachedSession>();
    const lastSetTitles = new Map<string, string>();
    const manualSessions = new Set<string>();
    const assistantSeen = new Set<string>();
    const lastEvaluationAt = new Map<string, number>();
    const llmCallCounts = new Map<string, number>();
    const pending = new Set<string>();
    const resolvedModels = new Map<string, ModelCandidate[]>();

    const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
      if (level === "debug" && !ENV_DEBUG) return;
      try {
        console[level === "debug" ? "debug" : level](`[session-namer] ${message}`);
      } catch {
        // Logging must never affect the OpenCode event loop.
      }
    };

    function isCurrentProject(session: CachedSession): boolean {
      return (
        session.projectID === projectID &&
        normalizePath(session.directory) === normalizePath(directory)
      );
    }

    function cacheFromDetails(details: {
      id: string;
      title?: string;
      projectID: string;
      parentID?: string;
      location: { directory: string };
    }): CachedSession {
      return {
        id: details.id,
        title: details.title ?? details.id,
        directory: details.location.directory,
        projectID: details.projectID,
        parentID: details.parentID,
      };
    }

    async function ensureSession(sessionID: string): Promise<CachedSession | undefined> {
      const cached = sessions.get(sessionID);
      if (cached) return cached;
      try {
        const details = (await ctx.session.get({ sessionID })) as unknown as Parameters<
          typeof cacheFromDetails
        >[0];
        const info = cacheFromDetails(details);
        sessions.set(sessionID, info);
        return info;
      } catch (error) {
        log("warn", `session lookup failed: ${errorMessage(error)}`);
        return undefined;
      }
    }

    async function findModels(providerID: string | null): Promise<ModelCandidate[]> {
      if (!providerID) {
        log("warn", "main session provider is unavailable");
        return [];
      }

      try {
        const response = (await ctx.catalog.provider.list()) as unknown as {
          data?: Array<{
            id: string;
            models: Record<string, { cost?: { input?: unknown; output?: unknown } }>;
          }>;
        };
        const providers = response?.data ?? [];
        const provider = providers.find((candidate) => candidate.id === providerID);
        if (!provider) {
          log("warn", `main session provider not found: ${providerID}`);
          return [];
        }

        const modelIDs = orderModelIDs(provider.models);
        if (ENV_MODEL) {
          const [requestedProviderID, requestedModelID] = ENV_MODEL.includes("/")
            ? ENV_MODEL.split("/", 2)
            : [providerID, ENV_MODEL];
          if (requestedProviderID !== providerID) {
            log(
              "warn",
              `ignoring model from another provider: ${ENV_MODEL} (main provider: ${providerID})`,
            );
          } else if (requestedModelID && provider.models[requestedModelID]) {
            return [
              { providerID, modelID: requestedModelID },
              ...modelIDs
                .filter((modelID) => modelID !== requestedModelID)
                .map((modelID) => ({ providerID, modelID })),
            ];
          } else {
            log("warn", `model not found in main provider: ${ENV_MODEL}`);
          }
        }

        return modelIDs.map((modelID) => ({ providerID, modelID }));
      } catch (error) {
        log("warn", `provider lookup failed: ${errorMessage(error)}`);
        return [];
      }
    }

    async function resolveModels(providerID: string | null): Promise<ModelCandidate[]> {
      if (!providerID) return [];
      const cached = resolvedModels.get(providerID);
      if (cached) return cached;
      const candidates = await findModels(providerID);
      resolvedModels.set(providerID, candidates);
      return candidates;
    }

    async function getConversation(sessionID: string): Promise<Conversation> {
      const empty: Conversation = {
        firstUser: "",
        latestUser: "",
        firstAssistant: "",
        latestAssistant: "",
        providerID: null,
      };
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown as Array<{
          type: string;
          text?: string;
          content?: Array<{ type: string; text?: string }>;
          model?: { providerID?: string };
        }>;
        const result = { ...empty };
        for (const entry of messages ?? []) {
          if (entry.type === "user") {
            const text = messageText(entry);
            if (!text) continue;
            if (!result.firstUser) result.firstUser = text;
            result.latestUser = text;
          } else if (entry.type === "assistant") {
            const providerID = messageProviderID(entry);
            if (providerID) result.providerID = providerID;
            const text = messageText(entry);
            if (!text) continue;
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
      conversation: Conversation,
      model: ModelCandidate,
      generate: GenerateClient,
    ): Promise<string | null> {
      const context: string[] = [];
      if (conversation.firstUser) {
        context.push(`First user message: "${conversation.firstUser.slice(0, 300)}"`);
      }
      if (conversation.latestUser && conversation.latestUser !== conversation.firstUser) {
        context.push(`Latest user message: "${conversation.latestUser.slice(0, 300)}"`);
      }
      if (conversation.firstAssistant) {
        context.push(`First assistant response: "${conversation.firstAssistant.slice(0, 400)}"`);
      }
      if (
        conversation.latestAssistant &&
        conversation.latestAssistant !== conversation.firstAssistant
      ) {
        context.push(`Latest assistant response: "${conversation.latestAssistant.slice(0, 400)}"`);
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

      try {
        const response = await generate.text({
          model: { providerID: model.providerID, id: model.modelID },
          prompt,
        });
        const text = response.text;
        const firstLine =
          text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? "";
        const title = sanitizeTitle(firstLine || text, ENV_MAX_LENGTH);
        return title.length > 0 ? title : null;
      } catch (error) {
        log(
          "warn",
          `title generation failed for ${model.providerID}/${model.modelID}: ${errorMessage(error)}`,
        );
        return null;
      }
    }

    async function evaluate(sessionID: string): Promise<void> {
      if (manualSessions.has(sessionID) || pending.has(sessionID)) return;
      const info = await ensureSession(sessionID);
      if (!info || info.parentID || !isCurrentProject(info)) {
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
        conversation.firstAssistant !== "" || conversation.latestAssistant !== "";
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
          const models = await resolveModels(conversation.providerID);
          let attempts = calls;
          for (const model of models) {
            if (attempts >= MAX_LLM_CALLS) break;
            attempts += 1;
            llmCallCounts.set(sessionID, attempts);
            log("info", `selected model: ${model.providerID}/${model.modelID}`);
            title = await generateTitle(conversation, model, ctx.generate);
            if (title) break;
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
        await ctx.session.rename({ sessionID, title });
        lastSetTitles.set(sessionID, title);
        log("info", `renamed session ${sessionID}: ${title}`);
      } catch (error) {
        log("warn", `title update failed: ${errorMessage(error)}`);
      }
    }

    function forget(sessionID: string): void {
      sessions.delete(sessionID);
      lastSetTitles.delete(sessionID);
      manualSessions.delete(sessionID);
      assistantSeen.delete(sessionID);
      lastEvaluationAt.delete(sessionID);
      llmCallCounts.delete(sessionID);
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await enqueue(queue, async () => {
            try {
              switch (event.type) {
                case "session.created": {
                  if (event.data.parentID) break;
                  const info = await ensureSession(event.data.sessionID);
                  if (info && !info.parentID && isCurrentProject(info)) {
                    if (!lastSetTitles.has(info.id)) {
                      lastSetTitles.set(info.id, info.title);
                    }
                    await evaluate(info.id);
                  }
                  break;
                }
                case "session.renamed": {
                  const renamed = event.data as { sessionID: string; title?: unknown };
                  const info = sessions.get(renamed.sessionID);
                  if (!info) break;
                  if (
                    typeof renamed.title === "string" &&
                    renamed.title !== lastSetTitles.get(info.id)
                  ) {
                    manualSessions.add(info.id);
                    log("info", `manual title detected, freezing session: ${info.id}`);
                  }
                  break;
                }
                case "session.deleted": {
                  forget(event.data.sessionID);
                  break;
                }
                case "session.text.ended": {
                  await evaluate(event.data.sessionID);
                  break;
                }
                default:
                  break;
              }
            } catch (error) {
              log("error", `event handling failed: ${errorMessage(error)}`);
            }
          });
        }
      } catch {
        // Aborted on dispose; nothing to report.
      }
    })();

    void ctx.session
      .hook("prompt", (event) => {
        void enqueue(queue, async () => {
          try {
            await evaluate(event.sessionID);
          } catch (error) {
            log("error", `prompt hook failed: ${errorMessage(error)}`);
          }
        });
      })
      .catch((error: unknown) => {
        log("error", `prompt hook registration failed: ${errorMessage(error)}`);
      });

    log("info", "session namer initialized");

    return () => {
      controller.abort();
    };
  },
});
