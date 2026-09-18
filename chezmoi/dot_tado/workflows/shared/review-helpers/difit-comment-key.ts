import { isRecord } from "./is-record.ts";

/// difit comment import 1 件を突合キー（type / filePath / position.side / position.line / body）へ
/// 正規化する。生成側（buildDifitComments）と保存側（difit-comments.json）の差分検出に使う。
/// `type` と `position.side` を含めることで、side 改変（new → old）や type 改変も
/// キー不一致として検出する。キーを生成できない要素は invalidReason を返し、
/// 呼び出し元が読み飛ばさず fail にできるようにする。
export function difitCommentKey(value: unknown): { key: string } | { invalidReason: string } {
  if (!isRecord(value)) return { invalidReason: "not an object" };
  const reasons: string[] = [];
  const type = value.type;
  const filePath = value.filePath;
  const position = isRecord(value.position) ? value.position : undefined;
  const side = position?.side;
  const line = position?.line;
  const body = value.body;
  if (typeof type !== "string" || !type.trim()) reasons.push("type");
  if (typeof filePath !== "string" || !filePath.trim()) reasons.push("filePath");
  if (side !== "new" && side !== "old") reasons.push("position.side");
  if (typeof line !== "number" || !Number.isInteger(line)) reasons.push("position.line");
  if (typeof body !== "string") reasons.push("body");
  if (reasons.length > 0) return { invalidReason: reasons.join("/") };
  return { key: `${type}\u0000${filePath}\u0000${side}\u0000${line}\u0000${body}` };
}
