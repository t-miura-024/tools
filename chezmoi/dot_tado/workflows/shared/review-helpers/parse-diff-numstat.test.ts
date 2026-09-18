import { describe, test, expect } from "bun:test";
import { parseDiffNumstat } from "./parse-diff-numstat.ts";

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("parseDiffNumstat: 通常・バイナリ・リネームの -z レコードをパースする", () => {
    const raw = [
      "1\t0\tsrc/a.ts",
      "-\t-\tbin.dat",
      "0\t2\tsrc/del.ts",
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "",
    ].join("\0");
    expect(parseDiffNumstat(raw)).toEqual([
      { path: "src/a.ts", added: 1, deleted: 0 },
      { path: "bin.dat", added: null, deleted: null },
      { path: "src/del.ts", added: 0, deleted: 2 },
      { path: "src/new.ts", origPath: "src/old.ts", added: 0, deleted: 0 },
    ]);
  });
});
describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("parseDiffNumstat: 契約外の出力は null を返す（fail-closed）", () => {
    expect(parseDiffNumstat("garbage")).toBeNull();
    // リネームの 2 パス形式でパスが欠落している
    expect(parseDiffNumstat("1\t0\t")).toBeNull();
  });
});
