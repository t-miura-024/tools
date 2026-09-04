// Managed by chezmoi: tools/chezmoi/dot_config/opencode/plugins/herdr-agent-state-bridge.ts
//
// herdr 公式プラグイン（./herdr-agent-state.js）は V1 形式のため opencode beta では
// 読み込めない。公式ファイル自体は herdr 管理なので触らず、このブリッジが
// V2 の hook / イベントを受けて V1 ハンドラへ転送する（公式ヘッダの指示通り
//「横に置く」配置）。herdr 側が V2 対応したらこのファイルは削除する。
//
// NOTE: このファイルは default エクスポート（Plugin.define の結果）のみを持つこと。
// opencode のローダーはこの形式を要求し、他の値エクスポートがあると
// ロード全体が失敗する。
import { Plugin } from "@opencode-ai/plugin";
import { HerdrAgentStatePlugin } from "./herdr-agent-state.js";
import { translateEvent } from "../lib/herdr-agent-state-bridge.js";

type V1Hooks = {
  "chat.message"?: (input: { sessionID: string }) => Promise<void>;
  event?: (input: {
    event: { type: string; properties: Record<string, unknown> };
  }) => Promise<void>;
};

export default Plugin.define({
  id: "mt-herdr-agent-state-bridge",
  setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      let v1: V1Hooks;
      try {
        v1 = (await HerdrAgentStatePlugin()) as V1Hooks;
      } catch {
        return;
      }
      if (!v1.event && !v1["chat.message"]) return;

      const emit = async (type: string, properties: Record<string, unknown>): Promise<void> => {
        try {
          await v1.event?.({ event: { type, properties } });
        } catch {
          // Reporting must never affect the OpenCode event loop.
        }
      };

      try {
        await ctx.tool.hook("execute.before", async (event) => {
          await emit("tool.execute.before", { sessionID: event.sessionID });
        });
        await ctx.tool.hook("execute.after", async (event) => {
          await emit("tool.execute.after", { sessionID: event.sessionID });
        });
        await ctx.session.hook("prompt", async (event) => {
          try {
            await v1["chat.message"]?.({ sessionID: event.sessionID });
          } catch {
            // Reporting must never affect the OpenCode event loop.
          }
        });
      } catch {
        return;
      }

      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const translated = translateEvent({
            type: event.type,
            data: event.data as Record<string, unknown>,
          });
          if (translated) {
            await emit(translated.type, translated.properties);
          }
        }
      } catch {
        // Aborted on dispose; nothing to report.
      }
    })();

    return () => {
      controller.abort();
    };
  },
});
