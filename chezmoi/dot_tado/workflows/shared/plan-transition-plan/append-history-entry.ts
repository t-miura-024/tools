import type { PlanStatus } from "../plan-init-config/types";

function formatHistoryEntry(
  sourceStatus: PlanStatus,
  targetStatus: PlanStatus,
  executionTransition = false,
  executionMarker: string | null = null,
): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const source = executionTransition ? " (mt-run-plan)" : "";
  const marker = executionMarker ? ` <!-- mt-run-plan-marker: ${executionMarker} -->` : "";
  return `- ${yyyy}-${mm}-${dd} ${hh}:${mi} [${targetStatus}] ${sourceStatus} から遷移${source}${marker}`;
}

export function appendHistoryEntry(
  body: string,
  sourceStatus: PlanStatus,
  targetStatus: PlanStatus,
  executionTransition = false,
  executionMarker: string | null = null,
): string {
  const entry = formatHistoryEntry(
    sourceStatus,
    targetStatus,
    executionTransition,
    executionMarker,
  );

  const sectionMatch = body.match(/## 🐢 履歴[ \t]*\n([\s\S]*?)(?=\n## |\s*$)/);

  if (sectionMatch) {
    const existingContent = sectionMatch[1].trim();
    if (existingContent.length > 0) {
      return body.replace(/(## 🐢 履歴[ \t]*\n)/, `$1${entry}\n`);
    }
    return body.replace(/(## 🐢 履歴[ \t]*\n)/, `$1\n${entry}\n`);
  }

  if (body.includes("## 🐢 履歴")) {
    return `${body.trimEnd()}\n\n${entry}\n`;
  }

  return `${body.trimEnd()}\n\n## 🐢 履歴\n\n${entry}\n`;
}
