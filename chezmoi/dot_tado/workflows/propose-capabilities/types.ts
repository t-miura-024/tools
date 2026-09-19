/// gate 回答の契約外形状に fail-closed な record 判定.
export interface GateAnswerRecord {
  value?: unknown;
  input?: unknown;
}

export function isGateAnswerRecord(value: unknown): value is GateAnswerRecord {
  return typeof value === "object" && value !== null;
}
