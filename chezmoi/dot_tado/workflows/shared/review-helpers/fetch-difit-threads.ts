import type { DifitThreadReply, DifitThreadView, DifitThreadsFetchResult } from "./types.ts";
import { findJsonObject } from "./find-json-object.ts";
import { isRecord } from "./is-record.ts";
import { parseDifitCheckRecord } from "./parse-difit-check-record.ts";
import { runDifitCommand } from "./run-difit-command.ts";

/// `mt difit threads --json` を実行し、state に固定された選択で未 resolve スレッドを
/// 読み取る（read-only）。サーバ状態・state ファイルは変更しない。
///
/// `mt difit threads --json` は state 不在・選択キー未記録・サーバ不応答・
/// 同一性照合失敗で非 0 exit し、stdout を返さない。その場合 output は undefined。
/// stdout が maxBuffer を超えた場合のみ `DifitOutputTooLargeError` を投げる
/// （呼び出し元が原因を CheckResult の理由として届けられるようにする）。
export function fetchDifitThreads(): DifitThreadsFetchResult {
  const result = runDifitCommand(["threads", "--json"]);
  // 最大級の入力（未 resolve 全件 + replies）を 2 回フルパースしないよう、
  // JSON.parse は findJsonObject の 1 回に統一し、gate 契約の取り出しも
  // その結果を再利用する。
  const parsed = findJsonObject(result.stdout);
  const gate = parseDifitCheckRecord(parsed);
  if (!gate || !parsed || !Array.isArray(parsed.threads)) return { stderr: result.stderr };

  const threads: DifitThreadView[] = [];
  for (const value of parsed.threads) {
    if (!isRecord(value)) return { stderr: result.stderr };
    const id = value.id;
    const filePath = value.filePath;
    const taxonomy = value.taxonomy;
    const blocking = value.blocking;
    const body = value.body;
    if (
      typeof id !== "string" ||
      typeof filePath !== "string" ||
      typeof taxonomy !== "string" ||
      typeof blocking !== "boolean" ||
      typeof body !== "string"
    ) {
      return { stderr: result.stderr };
    }
    if (!Array.isArray(value.replies)) return { stderr: result.stderr };
    const replies: DifitThreadReply[] = [];
    for (const reply of value.replies) {
      if (!isRecord(reply) || typeof reply.body !== "string") return { stderr: result.stderr };
      replies.push({
        author: typeof reply.author === "string" ? reply.author : null,
        body: reply.body,
      });
    }
    threads.push({
      id,
      filePath,
      position: value.position ?? null,
      taxonomy,
      blocking,
      body,
      author: typeof value.author === "string" ? value.author : null,
      replies,
    });
  }

  return {
    output: {
      passes: gate.passes,
      blocking_threads: gate.blocking_threads,
      threads,
      ...(gate.selection_drift ? { selection_drift: gate.selection_drift } : {}),
      ...(gate.selection_drift_error ? { selection_drift_error: gate.selection_drift_error } : {}),
    },
    stderr: result.stderr,
  };
}
