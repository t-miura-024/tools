/** `--numstat` の出力から統計を集計する。バイナリは '-' で行数不明のため数えない（推測で補完しない）。 */
export function parseNumstat(raw: string): {
  files: number;
  insertions: number;
  deletions: number;
} {
  const lines = raw.trim() ? raw.trim().split("\n") : [];
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [ins, del] = line.split("\t");
    const insNum = Number(ins);
    const delNum = Number(del);
    if (Number.isInteger(insNum)) insertions += insNum;
    if (Number.isInteger(delNum)) deletions += delNum;
  }
  return { files: lines.length, insertions, deletions };
}
