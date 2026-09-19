/// gate 回答値の純粋判定（plan-run の decideGateRework 定型）。
/// approve → pass / request_changes → continue / abort → error / 未知・未回答 → fail。
/// 旧 revise 値は受理しない（互換シムなし。fail の理由で移行先を案内する）。
/// loop 外の check は continue を返さない（エンジンが fail-fast する）。
export function decideGateRework(
  value: string | undefined,
): "pass" | "continue" | "error" | "fail" {
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "error";
  return "fail";
}
