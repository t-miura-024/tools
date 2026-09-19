import type { ArtifactExpectation } from "./types";

function missingJsonKeys(parsed: unknown, keys: string[]): string[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return keys;
  const record = parsed as Record<string, unknown>;
  return keys.filter((k) => !(k in record));
}

/** json 形式の中身検証。違反理由の配列を返す（空なら合格）。 */
export function validateJsonContent(content: string, expectation: ArtifactExpectation): string[] {
  const reasons: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [`${expectation.key}: invalid JSON`];
  }
  if (expectation.minItems !== undefined) {
    if (!Array.isArray(parsed)) {
      reasons.push(`${expectation.key}: expected a JSON array`);
    } else if (parsed.length < expectation.minItems) {
      reasons.push(
        `${expectation.key}: expected at least ${expectation.minItems} items, got ${parsed.length}`,
      );
    }
  }
  if (expectation.keys) {
    const missing = missingJsonKeys(parsed, expectation.keys);
    if (missing.length > 0) {
      reasons.push(`${expectation.key}: missing required keys: ${missing.join(", ")}`);
    }
  }
  if (expectation.itemKeys) {
    if (!Array.isArray(parsed)) {
      reasons.push(`${expectation.key}: expected a JSON array`);
    } else {
      parsed.forEach((item, i) => {
        const missing = missingJsonKeys(item, expectation.itemKeys!);
        if (missing.length > 0) {
          reasons.push(`${expectation.key}[${i}]: missing required keys: ${missing.join(", ")}`);
        }
      });
    }
  }
  return reasons;
}
