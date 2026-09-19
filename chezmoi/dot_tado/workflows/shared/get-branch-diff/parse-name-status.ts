import type { FileChange } from "./types";
import { mapStatus } from "./map-status";

/** `-z --name-status` の NUL 区切り出力を変更一覧へ変換する。 */
export function parseNameStatus(raw: string): FileChange[] {
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const token = parts[i++];
    const code = token[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (oldPath === undefined || newPath === undefined) break;
      files.push({ path: newPath, status: mapStatus(code), oldPath });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      files.push({ path, status: mapStatus(code), oldPath: null });
    }
  }
  return files;
}
