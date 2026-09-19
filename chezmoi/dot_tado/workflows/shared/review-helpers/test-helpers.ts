/**
 * review-helpers/ 配下のテスト共有ヘルパ（一時セッション dir・fake スクリプト runner・
 * difit 配布物解決）。bun test では *.test.ts として扱わない。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const dirs: string[] = [];

export function newSessionDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-helpers-"));
  dirs.push(dir);
  return dir;
}

/// fake スクリプトの安定 runner（exec 対象）。
/// macOS は新規の実行ファイルごとに exec スキャン（syspolicyd 等）を行い、高負荷時は
/// spawn が数分ブロックする。テストごとに変わる本体は exec されない `.body` に置き、
/// 実行される scriptPath はこの runner への symlink に固定することで、スキャンを
/// プロセスにつき 1 回に抑え、テストのランダムな長時間ブロックを防ぐ。
const FAKE_SCRIPT_RUNNER = path.join(tmpdir(), `mt-fake-script-runner-${process.pid}.sh`);

export function ensureFakeScriptRunner(): string {
  if (!existsSync(FAKE_SCRIPT_RUNNER)) {
    writeFileSync(FAKE_SCRIPT_RUNNER, `#!/bin/sh\nexec /bin/sh "$0.body" "$@"\n`);
    chmodSync(FAKE_SCRIPT_RUNNER, 0o755);
  }
  return FAKE_SCRIPT_RUNNER;
}

/// インストール済み difit 配布物の `dist/cli/utils.js` を解決する（parity テスト用）。
/// `which difit` の bin（`dist/cli/index.js` への symlink）から package.json の name を
/// たどる。
/// - `{ kind: "resolved" }`: shortHash の parity を検証できる
/// - `{ kind: "not-installed" }`: difit が無い（テストは skip。difit の導入は
///   manifests/bun-global.yml が担うため、テスト環境に difit を要求しない）
/// - `{ kind: "layout-changed" }`: difit はあるが dist/cli/utils.js を解決できない
///   （配布物構成の変更）。parity を検証できないため fail-closed でテストを失敗させる
export type DifitDistResolution =
  | { kind: "resolved"; utilsPath: string }
  | { kind: "not-installed" }
  | { kind: "layout-changed"; detail: string };

function resolveDifitDist(): DifitDistResolution {
  const which = spawnSync("which", ["difit"], { encoding: "utf-8" });
  const bin = which.status === 0 ? (which.stdout ?? "").trim().split("\n")[0] : "";
  if (!bin) return { kind: "not-installed" };

  let current: string;
  try {
    current = realpathSync(bin);
  } catch {
    return { kind: "layout-changed", detail: `${bin} の実体を解決できません` };
  }

  let dir = path.dirname(current);
  for (let i = 0; i < 6; i += 1) {
    const packageJsonPath = path.join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
        if (pkg.name === "difit") {
          const utilsPath = path.join(dir, "dist", "cli", "utils.js");
          return existsSync(utilsPath)
            ? { kind: "resolved", utilsPath }
            : { kind: "layout-changed", detail: `${utilsPath} が存在しません` };
        }
      } catch {
        // 壊れた package.json は探索を続ける
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    kind: "layout-changed",
    detail: `${bin} のパッケージルート（name=difit）を特定できません`,
  };
}

export const DIFIT_DIST = resolveDifitDist();
