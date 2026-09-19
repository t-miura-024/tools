import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dirs, DIFIT_DIST, ensureFakeScriptRunner, newSessionDir } from "./test-helpers.ts";
import { expectedDifitSelection } from "./expected-difit-selection.ts";
import { resolveEffectiveEffortBase } from "./resolve-effective-effort-base.ts";
import { validateDifitSelection } from "./validate-difit-selection.ts";

describe("expectedDifitSelection / validateDifitSelection (提示範囲の整合)", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = newSessionDir();
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function writeGit(script: string): void {
    const scriptPath = path.join(binDir, "git");
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${script}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  test("target なしは merge-base(HEAD, base)..'.' を期待する（単独 base 起動）", () => {
    writeGit(
      `[ "$1" = "merge-base" ] && { echo "1111111111111111111111111111111111111111"; exit 0; }
exit 1`,
    );
    expect(expectedDifitSelection("origin/main")).toEqual({
      expected: { base: "1111111", target: ".", baseMode: "merge-base" },
    });
  });

  test("target ありは merge-base(target, base)..target を期待する（three-dot 相当）", () => {
    writeGit(
      `if [ "$1" = "rev-parse" ]; then echo "2222222222222222222222222222222222222222"; exit 0; fi
if [ "$1" = "merge-base" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi
exit 1`,
    );
    expect(expectedDifitSelection("origin/main", "feature")).toEqual({
      expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
    });
  });

  test("git 解決に失敗したら error（fail-closed で提示を認めない）", () => {
    writeGit("exit 1");
    expect("error" in expectedDifitSelection("origin/main")).toBe(true);
    expect("error" in expectedDifitSelection("origin/main", "feature")).toBe(true);
  });

  test("validateDifitSelection は未記録 / baseMode / target の不一致を検出する", () => {
    const expected = { base: "1111111", target: "2222222", baseMode: "merge-base" };
    expect(
      validateDifitSelection(
        { base: "1111111", target: "2222222", baseMode: "merge-base" },
        expected,
      ),
    ).toBeUndefined();
    expect(validateDifitSelection(undefined, expected)).toContain("selection");
    // target が未反映（base 単独起動）: target="." のまま
    expect(
      validateDifitSelection({ base: "1111111", target: ".", baseMode: "merge-base" }, expected),
    ).toContain("一致しません");
    // baseMode 欠落（direct 起動）
    expect(validateDifitSelection({ base: "1111111", target: "2222222" }, expected)).toContain(
      "baseMode",
    );
  });

  test("resolveEffectiveEffortBase は明示 base / origin HEAD / main の順に解決する", () => {
    writeGit("exit 1");
    expect(resolveEffectiveEffortBase("develop")).toBe("develop");
    expect(resolveEffectiveEffortBase(undefined)).toBe("main");
    expect(resolveEffectiveEffortBase("  ")).toBe("main");

    writeGit(
      `[ "$1" = "symbolic-ref" ] && { echo "origin/develop"; exit 0; }
exit 1`,
    );
    expect(resolveEffectiveEffortBase(undefined)).toBe("develop");
  });

  test("validateDifitSelection の不一致メッセージが difit 側の解決形式変更の可能性を案内する", () => {
    const expected = { base: "1111111", target: "2222222", baseMode: "merge-base" };
    const message = validateDifitSelection(
      { base: "1111111", target: "3333333", baseMode: "merge-base" },
      expected,
    );
    expect(message).toContain("difit 側の解決形式変更の可能性");
    expect(message).toContain("parity テスト");
  });

  test("短縮ハッシュは difit 配布物（dist/cli/utils.js）の shortHash と一致する（parity）", async () => {
    if (DIFIT_DIST.kind === "not-installed") {
      // difit 未導入環境では検証対象がない（導入は manifests/bun-global.yml が担う）
      console.warn("[parity] difit が見つからないため shortHash parity を skip");
      return;
    }
    if (DIFIT_DIST.kind === "layout-changed") {
      // difit はあるのに dist の構成が変わっている。shortHash の写経を検証できないため
      // fail-closed で失敗させ、difit の配布物構成変更を検知する。
      throw new Error(
        `difit はインストールされていますが dist/cli/utils.js を解決できません（difit 側の配布物構成変更の可能性）: ${DIFIT_DIST.detail}`,
      );
    }

    const { shortHash } = (await import(pathToFileURL(DIFIT_DIST.utilsPath).href)) as {
      shortHash: (hash: string) => string;
    };
    const fullHash = "0123456789abcdef0123456789abcdef01234567";
    writeGit(
      `if [ "$1" = "rev-parse" ]; then echo "${fullHash}"; exit 0; fi
if [ "$1" = "merge-base" ]; then echo "${fullHash}"; exit 0; fi
exit 1`,
    );

    const withTarget = expectedDifitSelection("origin/main", "feature");
    expect("expected" in withTarget).toBe(true);
    if ("expected" in withTarget) {
      expect(withTarget.expected.base).toBe(shortHash(fullHash));
      expect(withTarget.expected.target).toBe(shortHash(fullHash));
      expect(withTarget.expected.base).toHaveLength(7);
    }

    const withoutTarget = expectedDifitSelection("origin/main");
    expect("expected" in withoutTarget).toBe(true);
    if ("expected" in withoutTarget) {
      expect(withoutTarget.expected.base).toBe(shortHash(fullHash));
    }
  });
});

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
