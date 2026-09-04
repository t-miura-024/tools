// Managed by chezmoi: tools/chezmoi/dot_config/opencode/lib/herdr-agent-state-bridge.ts
//
// herdr 公式プラグイン（../plugins/herdr-agent-state.js、herdr 管理）の V1 形式
// イベントを、opencode beta（V2）のイベントに翻訳する純粋ロジック。
// 公式ファイル自体には触らず、このブリッジを横に置く（公式ヘッダの指示通り）。
// このディレクトリは opencode のプラグイン自動検出対象外のため、
// 値エクスポートを含めてもローダーに誤って呼び出されることはない。

export type V2EventLike = {
  type: string;
  data?: Record<string, unknown>;
};

export type V1EventLike = {
  type: string;
  properties: Record<string, unknown>;
};

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  const sessionID = data.sessionID;
  if (typeof sessionID === "string" && sessionID) return sessionID;
  const form = data.form;
  if (form && typeof form === "object") {
    const formSessionID = (form as Record<string, unknown>).sessionID;
    if (typeof formSessionID === "string" && formSessionID) return formSessionID;
  }
  return undefined;
}

function infoOf(sessionID: string, parentID: unknown): Record<string, unknown> {
  const info: Record<string, unknown> = { id: sessionID };
  if (typeof parentID === "string" && parentID) info.parentID = parentID;
  return info;
}

/**
 * V2 イベントを herdr 公式プラグイン（V1）が解釈できる形式に翻訳する。
 * 対応付け不要なイベントは null を返す。
 */
export function translateEvent(event: V2EventLike): V1EventLike | null {
  const data = event.data ?? {};
  const sessionID = sessionIDOf(data);
  switch (event.type) {
    case "session.created": {
      if (!sessionID) return null;
      return {
        type: "session.created",
        properties: { sessionID, info: infoOf(sessionID, data.parentID) },
      };
    }
    case "session.renamed": {
      if (!sessionID) return null;
      return {
        type: "session.updated",
        properties: { sessionID, info: { id: sessionID } },
      };
    }
    case "session.status": {
      if (!sessionID) return null;
      return { type: "session.status", properties: { sessionID, status: data.status } };
    }
    case "session.execution.failed": {
      if (!sessionID) return null;
      return { type: "session.error", properties: { sessionID } };
    }
    case "session.idle": {
      if (!sessionID) return null;
      return { type: "session.idle", properties: { sessionID } };
    }
    case "session.deleted": {
      if (!sessionID) return null;
      return { type: "session.deleted", properties: { sessionID } };
    }
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed": {
      return { type: "session.compacted", properties: { sessionID } };
    }
    case "permission.asked": {
      if (!sessionID) return null;
      return { type: "permission.asked", properties: { sessionID } };
    }
    case "permission.replied": {
      return { type: "permission.replied", properties: { sessionID } };
    }
    case "form.created": {
      return { type: "question.asked", properties: { sessionID } };
    }
    case "form.replied": {
      return { type: "question.replied", properties: { sessionID } };
    }
    case "form.cancelled": {
      return { type: "question.rejected", properties: { sessionID } };
    }
    default:
      return null;
  }
}
