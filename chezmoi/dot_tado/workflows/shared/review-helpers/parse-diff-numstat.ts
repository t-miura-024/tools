import type { DiffNumstatEntry } from "./types.ts";

/// `git diff --numstat -z` の出力をパースする（純粋関数）。
///
/// -z では生パスが NUL 区切りで並び、通常エントリは `added\tdeleted\t<path>\0`、
/// リネーム / コピーは `added\tdeleted\t\0<orig>\0<new>\0` の形になる。契約外の
/// 出力は例外にせず null を返し、呼び出し元が fail-closed に扱えるようにする。
export function parseDiffNumstat(raw: string): DiffNumstatEntry[] | null {
  const tokens = raw.split("\0");
  const entries: DiffNumstatEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token);
    if (!match) return null;
    let path = match[3];
    let origPath: string | undefined;
    if (path === "") {
      origPath = tokens[index];
      index += 1;
      path = tokens[index] ?? "";
      index += 1;
      if (!origPath || !path) return null;
    }
    entries.push({
      path,
      origPath,
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return entries;
}
