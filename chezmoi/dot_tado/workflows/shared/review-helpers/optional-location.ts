import type { JsonRecord } from "./types.ts";
import { isRecord } from "./is-record.ts";

export function optionalLocation(item: JsonRecord): { filePath?: string; position?: unknown } {
  const location = isRecord(item.location) ? item.location : undefined;
  const filePathCandidate =
    item.filePath ?? item.file_path ?? location?.filePath ?? location?.file_path;
  const positionCandidate = item.position ?? location?.position;
  return {
    ...(typeof filePathCandidate === "string" && filePathCandidate.trim()
      ? { filePath: filePathCandidate }
      : {}),
    ...(isRecord(positionCandidate) ? { position: positionCandidate } : {}),
  };
}
