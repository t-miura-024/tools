import { isObjectRecord } from "../types.ts";

export function isEnoent(error: unknown): boolean {
  return isObjectRecord(error) && error.code === "ENOENT";
}
