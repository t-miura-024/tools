/// commitish（base/head）の形状検証。spawnSync配列呼びのためshell注入は起きないが、
/// `-`始まりはgitオプションとして解釈される（オプションインジェクション）ため拒否する。
/// rev-parse/diffは先頭`--`が意味を変える（revでなくpath扱い・検証失敗）ため、
/// 検証による拒否が主防御であり、`--`は意味を保てる位置に置く。
export function isValidCommitish(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref === "--" || ref.startsWith("-")) return false;
  if (ref.startsWith(".") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) {
    return false;
  }
  // 単体のcommitishに範囲演算子やrefspec区切りを含めない（呼び出し元で`..`分割済み）。
  if (ref.includes("..") || ref.includes(":")) return false;
  if (/[\0\s;|&$`"'<>(){}*?![\]\\]/.test(ref)) return false;
  return true;
}
