import type { CheckResult } from "tado";
import type { AuditCheck } from "../scripts/audit";

export function toCheckResult(checks: AuditCheck[]): CheckResult {
  const errored = checks.filter((c) => c.status === "error");
  if (errored.length > 0) {
    return { status: "error", reasons: errored.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    return { status: "fail", reasons: failed.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  return { status: "pass", reasons: checks.map((c) => `${c.check_name}: ${c.detail}`) };
}
