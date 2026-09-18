import { parseDiffHeaderPath } from "./parse-diff-header-path.ts";

export function parseDiffChangedLines(diffRaw: string | undefined): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!diffRaw || !diffRaw.trim()) return result;

  const lines = diffRaw.split("\n");
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      // バイナリ差分は追加行なしとしてスキップ
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      // `+++ b/<path>` / `+++ "b/<path>"` / `+++ /dev/null`。
      // C-quote（core.quotePath 既定で非 ASCII・引用符を含むパスが引用される）は
      // parseDiffHeaderPath が逆写像し、レビュアーが返す生の filePath とキーを一致させる。
      currentFile = parseDiffHeaderPath(line.slice(4));
      if (currentFile !== null && !result.has(currentFile)) {
        result.set(currentFile, new Set<number>());
      }
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        newLine = Number.parseInt(match[1], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const set = result.get(currentFile);
      if (set) set.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // old側削除は newLine を進めない
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — 無視
    } else {
      // 差分のメタ行は無視（index, ---, etc.は既に処理済み）
    }
  }

  // 空集合のファイル（バイナリや削除で追加行なし）は除外して返す（判定を file_not_in_diff に倒すため）
  for (const [file, set] of result) {
    if (set.size === 0) result.delete(file);
  }

  return result;
}
