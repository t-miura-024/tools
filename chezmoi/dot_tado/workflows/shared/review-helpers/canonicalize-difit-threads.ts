import type { DifitBlockingThread } from "./types.ts";

/// blocking_threads を daemon 出力と verdict の間で突合するための正規化文字列。
///
/// 配列順と省略された任意フィールド（id / file / line / taxonomy / replies）の
/// 差を吸収しつつ、内容が 1 つでも異なれば文字列も異なる。並び替えキーは
/// id（なければ file+line+body）で安定させる。
export function canonicalizeDifitThreads(threads: DifitBlockingThread[]): string {
  const normalized = threads.map((thread) => ({
    id: thread.id ?? "",
    file: thread.file ?? "",
    line: thread.line ?? null,
    taxonomy: thread.taxonomy ?? "",
    body: thread.body,
    replies: thread.replies ?? [],
  }));
  normalized.sort((a, b) => {
    const keyA = a.id || `${a.file}\u0000${JSON.stringify(a.line)}\u0000${a.body}`;
    const keyB = b.id || `${b.file}\u0000${JSON.stringify(b.line)}\u0000${b.body}`;
    return keyA.localeCompare(keyB);
  });
  return JSON.stringify(normalized);
}
