/**
 * mt-review-helpers.ts の成果物読み取り（findArtifactText / readSessionFile /
 * isPathInside）と difit セッション状態の読み取り（readDifitReviewState）・
 * 後始末（cleanupDifitSession）・選択整合（expectedDifitSelection / validateDifitSelection）の
 * 自動テスト。成果物読み取りの正典は tado 本体の `src/artifacts.ts`。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactRecord } from "tado";
import {
  auditFindingsNormalization,
  buildReviewCoverage,
  canonicalizeDifitThreads,
  cleanupDifitSession,
  countDiffLinesByPath,
  DIFIT_MAX_BUFFER_BYTES,
  diffCompletenessReasons,
  diffContainsPath,
  diffContainsUntrackedFile,
  diffDifitCommentPresence,
  diffDifitComments,
  diffNumstatReasons,
  describeDifitSelectionDrift,
  difitCommandFailureMessage,
  difitStderrReasons,
  DifitOutputTooLargeError,
  DifitSpawnError,
  DifitTimeoutError,
  expectedDifitSelection,
  fetchDifitThreads,
  findArtifactText,
  findMissingUntrackedFiles,
  formatReviewComment,
  indexDiffText,
  isDifitOutputTooLargeError,
  isDifitSpawnError,
  isDifitTimeoutError,
  isolateDifitFeedback,
  isPathInside,
  isProcessAlive,
  isRoundLimitReached,
  listStagedFiles,
  listUntrackedFiles,
  missingStagedFilesReasons,
  parseDiffChangedLines,
  parseDiffNumstat,
  parseDifitCheck,
  quoteGitPathForDiff,
  readDifitReviewState,
  readSessionFile,
  requireDifitSelectionDrift,
  resolveEffectiveEffortBase,
  REVIEW_ROUND_LIMIT,
  runDifitCommand,
  unquoteGitPath,
  validateDifitSelection,
  validateEffort,
  validateFindingsJson,
  validateVerifyFixJson,
} from "./mt-review-helpers.ts";
import type { DiffNumstatEntry } from "./mt-review-helpers.ts";
import type { DifitThreadView, FindingsJson } from "./mt-review-helpers.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});

function newSessionDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mt-review-helpers-"));
  dirs.push(dir);
  return dir;
}

/// fake スクリプトの安定 runner（exec 対象）。
/// macOS は新規の実行ファイルごとに exec スキャン（syspolicyd 等）を行い、高負荷時は
/// spawn が数分ブロックする。テストごとに変わる本体は exec されない `.body` に置き、
/// 実行される scriptPath はこの runner への symlink に固定することで、スキャンを
/// プロセスにつき 1 回に抑え、テストのランダムな長時間ブロックを防ぐ。
const FAKE_SCRIPT_RUNNER = path.join(tmpdir(), `mt-fake-script-runner-${process.pid}.sh`);

function ensureFakeScriptRunner(): string {
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
type DifitDistResolution =
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

const DIFIT_DIST = resolveDifitDist();

describe("isPathInside", () => {
  test("配下は真", () => {
    const base = newSessionDir();
    expect(isPathInside(base, path.join(base, "a", "b.txt"))).toBe(true);
  });

  test("親への脱出は偽", () => {
    const base = newSessionDir();
    expect(isPathInside(base, path.join(base, "..", "evil.txt"))).toBe(false);
  });
});

describe("readSessionFile", () => {
  test("往復できる", () => {
    const dir = newSessionDir();
    writeFileSync(path.join(dir, "memo.md"), "hello", "utf-8");
    expect(readSessionFile(dir, "memo.md")).toBe("hello");
  });

  test("未存在は undefined", () => {
    expect(readSessionFile(newSessionDir(), "missing.md")).toBeUndefined();
  });

  test("経路外は例外", () => {
    expect(() => readSessionFile(newSessionDir(), "../evil.md")).toThrow("path traversal");
  });
});

describe("findArtifactText", () => {
  function artifactRecord(artifactKey: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: "ses_test",
      stepKey: "step",
      artifactKey,
      filePath,
      createdAt: "2026-01-01T00:00:00Z",
    };
  }

  test("セッション内の成果物を読める", () => {
    const dir = newSessionDir();
    const file = path.join(dir, "repo-info.json");
    writeFileSync(file, '{"owner":"o"}', "utf-8");
    const artifacts = [artifactRecord("repo-info.json", file)];
    expect(findArtifactText(artifacts, "repo-info.json", dir)).toBe('{"owner":"o"}');
    expect(readFileSync(file, "utf-8")).toBe('{"owner":"o"}');
  });

  test("未登録のキーは undefined", () => {
    expect(findArtifactText([], "repo-info.json", newSessionDir())).toBeUndefined();
  });

  test("セッション外の解決は例外（process.cwd() 照合の誤りを再発させない）", () => {
    const dir = newSessionDir();
    const outside = path.join(tmpdir(), "outside.txt");
    const artifacts = [artifactRecord("k", outside)];
    expect(() => findArtifactText(artifacts, "k", dir)).toThrow("path traversal");
  });
});

describe("readDifitReviewState (fail-closed state 読み取り)", () => {
  let binDir: string;
  let repoRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = newSessionDir();
    repoRoot = path.join(binDir, "repo");
    mkdirSync(path.join(repoRoot, ".difit"), { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  function fakeGit(root: string): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${root}" && exit 0
exit 1`,
    );
  }

  function statePath(): string {
    return path.join(repoRoot, ".difit", "difit-review.json");
  }

  function writeDifitState(state: Record<string, unknown> | string): void {
    const body = typeof state === "string" ? state : JSON.stringify(state);
    writeFileSync(statePath(), body);
  }

  test("port / pid / selection を読み取り、selection は任意（旧 state では undefined）", () => {
    fakeGit(repoRoot);
    writeDifitState({
      port: 4966,
      pid: process.pid,
      selection: { base: "abc1234", target: ".", baseMode: "merge-base" },
    });
    expect(readDifitReviewState()).toEqual({
      state: {
        port: 4966,
        pid: process.pid,
        selection: { base: "abc1234", target: ".", baseMode: "merge-base" },
      },
    });

    writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
    expect(readDifitReviewState()).toEqual({ state: { port: 4966, pid: process.pid } });
  });

  test("状態ファイルが無ければ missing（不在と読み取り不能を区別する）", () => {
    fakeGit(repoRoot);
    expect(readDifitReviewState()).toEqual({ missing: true });
  });

  test(".difit が symlink なら error（リンク先の state を読まない fail-closed）", () => {
    fakeGit(repoRoot);
    const target = path.join(binDir, "linked-difit");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "difit-review.json"),
      JSON.stringify({ port: 4966, pid: process.pid }),
    );
    rmSync(path.join(repoRoot, ".difit"), { recursive: true, force: true });
    symlinkSync(target, path.join(repoRoot, ".difit"));

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("symlink");
  });

  test("state ファイルが symlink なら error（リンク先を state として読まない fail-closed）", () => {
    fakeGit(repoRoot);
    const linked = path.join(binDir, "linked-state.json");
    writeFileSync(linked, JSON.stringify({ port: 4966, pid: process.pid }));
    symlinkSync(linked, statePath());

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("symlink");
  });

  test("port が不正なら error", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 0, pid: process.pid, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("port");
  });

  test("pid が不正（<= 0）なら error", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 4966, pid: -1, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("pid");
  });

  test("selection が不正なら error（選択固定キーの契約違反）", () => {
    fakeGit(repoRoot);
    writeDifitState({ port: 4966, pid: process.pid, selection: {} });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("selection");
  });

  test("JSON が不正なら error", () => {
    fakeGit(repoRoot);
    writeDifitState("not json");
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("JSON オブジェクト");
  });

  test("git rev-parse が失敗すれば error（不在と同一視しない）", () => {
    writeScript("git", "exit 1");
    writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("git");
  });

  test("GIT_DIR 等の git 文脈を除去して git を実行する", () => {
    process.env.GIT_DIR = "/bogus/git-dir";
    try {
      // git 側に GIT_DIR が残っていれば失敗させる
      writeScript(
        "git",
        `[ -n "$GIT_DIR" ] && { echo "GIT_DIR leaked" >&2; exit 3; }
[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${repoRoot}" && exit 0
exit 1`,
      );
      writeDifitState({ port: 4966, pid: process.pid, comments: [], difit_args: [], tab: null });
      expect(readDifitReviewState()).toEqual({ state: { port: 4966, pid: process.pid } });
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  test("state が通常ファイルでない（ディレクトリ化）なら error", () => {
    fakeGit(repoRoot);
    rmSync(statePath(), { force: true });
    mkdirSync(statePath(), { recursive: true });

    const read = readDifitReviewState();
    expect("error" in read && read.error).toContain("difit-review.json");
  });
});

describe("canonicalizeDifitThreads", () => {
  test("配列順が違っても同じ文字列になる", () => {
    const a = [
      { id: "t1", file: "src/a.ts", line: 1, taxonomy: "issue", body: "A", replies: [] },
      { id: "t2", file: "src/b.ts", line: 2, taxonomy: "human", body: "B", replies: ["r"] },
    ];
    const b = [a[1], a[0]];
    expect(canonicalizeDifitThreads(a)).toBe(canonicalizeDifitThreads(b));
  });

  test("body が改変されていれば異なる文字列になる", () => {
    const a = [{ id: "t1", body: "original", replies: [] }];
    const b = [{ id: "t1", body: "rewritten", replies: [] }];
    expect(canonicalizeDifitThreads(a)).not.toBe(canonicalizeDifitThreads(b));
  });

  test("replies の欠落は空配列として比較される", () => {
    const a = [{ id: "t1", body: "A", replies: [] as string[] }];
    const b = [{ id: "t1", body: "A" }];
    expect(canonicalizeDifitThreads(a)).toBe(canonicalizeDifitThreads(b));
  });
});

describe("requireDifitSelectionDrift (fail-closed の契約判定)", () => {
  test("解釈できた drift はそのまま返す", () => {
    const drift = { detection: "none" as const };
    expect(requireDifitSelectionDrift({ selection_drift: drift })).toEqual({ drift });
  });

  test("フィールド欠落は契約違反（ドリフトなしに倒さない）", () => {
    const result = requireDifitSelectionDrift({});
    expect("violation" in result).toBe(true);
    expect("violation" in result ? result.violation : "").toContain("契約違反");
    expect("violation" in result ? result.violation : "").toContain("selection_drift");
  });

  test("解釈不能（selection_drift_error）は理由つきの契約違反で返す", () => {
    const result = requireDifitSelectionDrift({
      selection_drift_error: "selection_drift.detection が未知の値です: drifted",
    });
    expect("violation" in result).toBe(true);
    expect("violation" in result ? result.violation : "").toContain("解釈できません");
    expect("violation" in result ? result.violation : "").toContain("drifted");
  });
});

describe("isRoundLimitReached (verdict round 上限)", () => {
  test("round > 5 は通過していても true（上限超過は人間判断へ）", () => {
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT + 1, passed: true })).toBe(true);
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT + 1, passed: false })).toBe(true);
  });

  test("round = 5 は未通過のみ true", () => {
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT, passed: false })).toBe(true);
    expect(isRoundLimitReached({ round: REVIEW_ROUND_LIMIT, passed: true })).toBe(false);
  });

  test("round < 5 は常に false", () => {
    expect(isRoundLimitReached({ round: 1, passed: false })).toBe(false);
    expect(isRoundLimitReached({ round: 2, passed: false })).toBe(false);
  });
});

describe("formatReviewComment (対象行の無害化)", () => {
  test("filePath のバックティックでコードスパンを閉じ、画像記法を注入できない", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "実際の詳細",
      filePath: "src/a`.ts![x](https://evil.example/p.png)",
      line: 7,
    });

    // バックティックは `'` へ置換され、コードスパンは 1 組のみ
    // （filePath のバックティックで閉じられない。画像記法はスパン内で解釈されない）
    const targetLine = result.body.split("\n").find((line) => line.startsWith("**対象**:"))!;
    expect(targetLine.match(/`/g) ?? []).toHaveLength(2);
    expect(targetLine).toBe("**対象**: `src/a'.ts![x](https://evil.example/p.png):7`");
  });

  test("filePath の改行で対象行以降へ偽の Markdown 行を注入できない", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "実際の詳細",
      filePath: "src/a.ts\n**詳細**: 偽\n![img](https://evil.example/p.png)",
      line: 7,
    });

    const targetLine = result.body.split("\n").find((line) => line.startsWith("**対象**:"))!;
    // 改行は空白に畳まれ、偽の行が独立して現れない（画像記法もスパン内に閉じる）
    expect(targetLine).toContain("src/a.ts **詳細**: 偽 ![img](https://evil.example/p.png):7");
    expect(targetLine).not.toContain("\n");
    expect(result.body.split("\n").filter((line) => line === "**詳細**: 偽")).toHaveLength(0);
    // テンプレートの詳細ラベルは 1 つだけ（注入された偽ラベルは対象行内に畳まれる）
    expect(result.body.split("\n").filter((line) => line.startsWith("**詳細**:"))).toHaveLength(1);
    // 画像記法として解釈される行が対象行以外に現れない
    expect(result.body.split("\n").filter((line) => line.includes("![img]("))).toEqual([
      targetLine,
    ]);
  });

  test("[id] を含む filePath はコードスパン内でバックスラッシュエスケープせずに表示する（回帰）", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "dynamic route のパス",
      filePath: "src/app/[id]/page.tsx",
      line: 3,
    });

    // CommonMark のコードスパン内ではバックスラッシュエスケープが解釈されないため、
    // `\[id\]` と表示される退行を固定する
    expect(result.body).toContain("**対象**: `src/app/[id]/page.tsx:3`");
    expect(result.body).not.toContain("\\[id\\]");
  });

  test("detail の生テキストはリンク・画像記法を無害化する（対象行のコードスパンと分離）", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "![img](https://evil.example/p.png) と [link](https://evil.example/)",
      filePath: "src/app/[id]/page.tsx",
      line: 3,
    });

    expect(result.body).toContain("!\\[img\\]");
    expect(result.body).toContain("\\[link\\]");
  });

  test("filePath なしのファイルレベル対象はコードスパンなしで表示する", () => {
    const result = formatReviewComment({ severity: "want", axis: "arch-1", detail: "d" });
    expect(result.body).toContain("**対象**: (ファイルレベル)");
  });
});

describe("fetchDifitThreads (選択固定・read-only)", () => {
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

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  /// `mt difit threads --json` 以外の引数では exit 64 にして退行を検出する。
  function fakeMtThreads(output: string, exitCode = 0): void {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${output}'
exit ${exitCode}`,
    );
  }

  /// stderr へ診断メッセージを出す fake mt（選択ドリフト警告・同一性照合エラーの回収テスト用）。
  function fakeMtThreadsWithStderr(output: string, exitCode: number, stderr: string): void {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${output}'
printf '%s\\n' '${stderr}' >&2
exit ${exitCode}`,
    );
  }

  test("mt difit threads --json の契約をパースして返す（blocking_threads は check と同形）", () => {
    const thread = {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 12 },
      taxonomy: "issue",
      blocking: true,
      body: "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\nbody",
      author: null,
      replies: [{ author: "User", body: "human reply" }],
    };
    const blocking = {
      id: "t1",
      file: "src/a.ts",
      line: 12,
      taxonomy: "issue",
      body: thread.body,
      replies: ["human reply"],
    };
    fakeMtThreads(
      JSON.stringify({
        passes: false,
        selection: { base: "aaa", target: "bbb" },
        threads: [thread],
        blocking_threads: [blocking],
      }),
    );

    const result = fetchDifitThreads();

    expect(result.output).toBeDefined();
    expect(result.output!.passes).toBe(false);
    expect(result.output!.blocking_threads).toEqual([blocking]);
    expect(result.output!.threads).toHaveLength(1);
    expect(result.output!.threads[0]).toMatchObject({
      id: "t1",
      filePath: "src/a.ts",
      taxonomy: "issue",
      blocking: true,
      body: thread.body,
      replies: [{ author: "User", body: "human reply" }],
    });
  });

  test("コマンド失敗（セッション不在・選択未記録・サーバ死）は output undefined（無音 pass しない）", () => {
    fakeMtThreads("", 1);
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("threads 配列が無い出力は output undefined（契約違反）", () => {
    fakeMtThreads(JSON.stringify({ passes: true, blocking_threads: [] }));
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("threads 要素の契約違反（replies 欠落）は output undefined", () => {
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [
          { id: "t1", filePath: "src/a.ts", taxonomy: "issue", blocking: false, body: "b" },
        ],
        blocking_threads: [],
      }),
    );
    expect(fetchDifitThreads().output).toBeUndefined();
  });

  test("stderr を成功時も失敗時も回収する（選択ドリフト警告・同一性照合エラーを捨てない）", () => {
    fakeMtThreadsWithStderr(
      JSON.stringify({ passes: true, threads: [], blocking_threads: [] }),
      0,
      "mt difit: 警告: ブラウザの diff 選択が起動時と異なります",
    );
    const okResult = fetchDifitThreads();
    expect(okResult.output).toBeDefined();
    expect(okResult.stderr).toContain("ブラウザの diff 選択が起動時と異なります");

    fakeMtThreadsWithStderr("", 1, "mt difit: 記録された pid が記録 port を LISTEN していません");
    const failed = fetchDifitThreads();
    expect(failed.output).toBeUndefined();
    expect(failed.stderr).toContain("LISTEN していません");
  });

  test("threads --json の selection_drift（detection / expected / current）を型ガードで取り込む", () => {
    const thread = {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 1 },
      taxonomy: "issue",
      blocking: true,
      body: "body",
      author: null,
      replies: [],
    };
    fakeMtThreads(
      JSON.stringify({
        passes: false,
        threads: [thread],
        blocking_threads: [],
        selection_drift: {
          detection: "detected",
          expected: { base: "aaa", target: "bbb", baseMode: "merge-base" },
          current: { base: "ccc", target: "ddd" },
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "detected",
      expected: { base: "aaa", target: "bbb", baseMode: "merge-base" },
      current: { base: "ccc", target: "ddd" },
    });

    // probe 失敗時は current が null（検知不能）
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: {
          detection: "unavailable",
          expected: { base: "aaa", target: "bbb" },
          current: null,
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "unavailable",
      expected: { base: "aaa", target: "bbb" },
    });

    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: {
          detection: "none",
          expected: { base: "aaa", target: "bbb" },
          current: { base: "aaa", target: "bbb" },
        },
      }),
    );
    expect(fetchDifitThreads().output!.selection_drift).toEqual({
      detection: "none",
      expected: { base: "aaa", target: "bbb" },
      current: { base: "aaa", target: "bbb" },
    });
  });

  test("旧形式（boolean / {detected}）の selection_drift は解釈せず undefined（新スキーマのみ受理）", () => {
    fakeMtThreads(
      JSON.stringify({ passes: true, threads: [], blocking_threads: [], selection_drift: false }),
    );
    const fromBoolean = fetchDifitThreads();
    expect(fromBoolean.output!.selection_drift).toBeUndefined();
    // フィールドは存在するが解釈できない = 契約違反マーカーを立てる（無音でドリフトなしにしない）
    expect(fromBoolean.output!.selection_drift_error).toContain("オブジェクト");

    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: { detected: true, expected: { base: "aaa", target: "bbb" } },
      }),
    );
    const fromLegacy = fetchDifitThreads();
    expect(fromLegacy.output!.selection_drift).toBeUndefined();
    expect(fromLegacy.output!.selection_drift_error).toContain("detection");
  });

  test("selection_drift の未知の detection は selection_drift_error に理由を記録する", () => {
    fakeMtThreads(
      JSON.stringify({
        passes: true,
        threads: [],
        blocking_threads: [],
        selection_drift: { detection: "drifted" },
      }),
    );
    const result = fetchDifitThreads();
    expect(result.output!.selection_drift).toBeUndefined();
    expect(result.output!.selection_drift_error).toContain("drifted");
  });

  test("selection_drift の欠落は error マーカーを立てない（done など drift を省く経路を区別する）", () => {
    fakeMtThreads(JSON.stringify({ passes: true, threads: [], blocking_threads: [] }));
    const result = fetchDifitThreads();
    expect(result.output!.selection_drift).toBeUndefined();
    expect(result.output!.selection_drift_error).toBeUndefined();
  });
});

describe("diffDifitComments", () => {
  const expected = [
    { type: "thread", filePath: "src/a.ts", position: { side: "new", line: 1 }, body: "A" },
    { type: "thread", filePath: "src/b.ts", position: { side: "new", line: 2 }, body: "B" },
  ];

  test("完全一致は match（順序差は許容）", () => {
    const result = diffDifitComments(expected, [expected[1], expected[0]]);
    expect(result.match).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  test("findings の部分集合（欠落）を missing として検出する", () => {
    const result = diffDifitComments(expected, [expected[0]]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected).toEqual([]);
  });

  test("body 改変は欠落と余剰として検出する", () => {
    const tampered = [expected[0], { ...expected[1], body: "B rewritten" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
  });

  test("配列でない actual は match=false", () => {
    const result = diffDifitComments(expected, { threads: expected });
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.invalid).toEqual([]);
  });

  test("position.side の改変（new → old）を検出する", () => {
    const tampered = [expected[0], { ...expected[1], position: { side: "old", line: 2 } }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
    expect(result.invalid).toEqual([]);
  });

  test("type の改変を検出する", () => {
    const tampered = [expected[0], { ...expected[1], type: "reply" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.missing[0]).toContain("src/b.ts:2");
    expect(result.unexpected[0]).toContain("src/b.ts:2");
  });

  test("position なしの余剰要素は読み飛ばさず invalid として fail する", () => {
    const surplus = [...expected, { type: "thread", filePath: "src/c.ts", body: "surplus" }];
    const result = diffDifitComments(expected, surplus);
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toContain("[2]");
    expect(result.invalid[0]).toContain("position");
  });

  test("配列長が同じでもキー生成不能要素があれば match=false（配列長とキー数の不一致検出）", () => {
    const tampered = [expected[0], { type: "thread", filePath: "src/b.ts", body: "B" }];
    const result = diffDifitComments(expected, tampered);
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
  });
});

describe("diffDifitCommentPresence", () => {
  function thread(overrides: Partial<DifitThreadView> = {}): DifitThreadView {
    return {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 1 },
      taxonomy: "issue",
      blocking: true,
      body: "A",
      author: null,
      replies: [],
      ...overrides,
    };
  }

  function comment(body: string, line = 1): Record<string, unknown> {
    return { type: "thread", filePath: "src/a.ts", position: { side: "new", line }, body };
  }

  test("位置まで一致する注入は match", () => {
    const result = diffDifitCommentPresence([comment("A")], [thread()]);
    expect(result.match).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  test("body 一致でも position.line の差し替えは missing として検出する", () => {
    const result = diffDifitCommentPresence([comment("A", 5)], [thread()]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("src/a.ts:5");
  });

  test("body 一致でも position.side の差し替えは missing として検出する", () => {
    const result = diffDifitCommentPresence(
      [comment("A")],
      [thread({ position: { side: "old", line: 1 } })],
    );
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  test("同一 body 2 件の片方欠落は missing として検出する（multiset）", () => {
    const result = diffDifitCommentPresence([comment("A"), comment("A")], [thread()]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  test("サーバ側の余剰は許容し、キー生成不能なサーバ要素は無視する", () => {
    const result = diffDifitCommentPresence(
      [comment("A")],
      [
        thread(),
        thread({ body: "前ラウンドの未 resolve" }),
        thread({ position: null, body: "人間" }),
      ],
    );
    expect(result.match).toBe(true);
  });

  test("注入側のキー生成不能（position なし）は invalid として fail する", () => {
    const result = diffDifitCommentPresence(
      [{ type: "thread", filePath: "src/a.ts", body: "no position" }],
      [thread({ body: "no position" })],
    );
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
  });
});

describe("auditFindingsNormalization", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,4 @@",
    " context",
    "+added1",
    "+added2",
    " tail",
  ].join("\n");

  function findingsJson(
    findings: Array<Record<string, unknown>>,
    filteredOut?: { count: number; items: Array<Record<string, unknown>> },
  ): FindingsJson {
    return {
      round: 1,
      width: "medium",
      depth: "medium",
      findings: findings as never,
      counts: { must: 0, should: 0, want: 0 },
      ...(filteredOut ? { filteredOut: filteredOut as never } : {}),
    };
  }

  function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      axis: "req-1",
      severity: "must",
      detail: "detail",
      filePath: "src/a.ts",
      position: { side: "new", line: 2 },
      ...overrides,
    };
  }

  test("raw と findings が機械導出で一致すれば match", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, diff, findingsJson(raw), { untrackedFiles: [] });
    expect(audit.match).toBe(true);
    expect(audit.reasons).toEqual([]);
  });

  test("集約段で must を落とした findings は欠落として fail（counts が自己整合でも検出）", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("欠落 1 件");
    expect(audit.reasons.join("\n")).toContain("req-1 must src/a.ts 2");
  });

  test("diff フィルタで除外した finding は filteredOut への記録が必須", () => {
    const raw = [finding({ position: { side: "new", line: 99 } })];
    const withoutFiltered = auditFindingsNormalization(raw, diff, findingsJson([]), {
      untrackedFiles: [],
    });
    expect(withoutFiltered.match).toBe(false);
    expect(withoutFiltered.reasons.join("\n")).toContain("filteredOut");

    const withFiltered = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "line_not_in_added" }],
      }),
      { untrackedFiles: [] },
    );
    expect(withFiltered.match).toBe(true);

    // count と items 件数の不一致も検出する
    const countMismatch = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 2,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "line_not_in_added" }],
      }),
      { untrackedFiles: [] },
    );
    expect(countMismatch.match).toBe(false);
    expect(countMismatch.reasons.join("\n")).toContain("filteredOut.count");
  });

  test("axis / severity / detail 不正の例外除外は内訳に計上して match", () => {
    const raw = [finding({ axis: "unknown-axis" })];
    const audit = auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] });
    expect(audit.match).toBe(true);
  });

  test("±2 行マージで統合された findings を受理する（軸/深刻度/位置の multiset 比較）", () => {
    const raw = [
      finding({ detail: "a" }),
      finding({
        axis: "req-2",
        severity: "should",
        detail: "b",
        position: { side: "new", line: 3 },
      }),
    ];
    const merged = [
      {
        axis: "req-1",
        severity: "must",
        detail: "a\n\n--- merged (±2) ---\n\nb",
        filePath: "src/a.ts",
        position: { side: "new", line: 2 },
      },
    ];
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(merged), { untrackedFiles: [] }).match,
    ).toBe(true);

    // マージせず 2 件のまま残した findings は余剰として fail
    const notMerged = auditFindingsNormalization(raw, diff, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(notMerged.match).toBe(false);
    expect(notMerged.reasons.join("\n")).toContain("余剰 1 件");
  });

  test("reviewer-outputs.json が配列でなければ fail", () => {
    const audit = auditFindingsNormalization({ findings: [] }, diff, findingsJson([]), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("JSON array");
  });

  test("解析済み Map を渡すと内部で再パースせず、その Map でフィルタする（二重パース回避）", () => {
    const raw = [finding()]; // src/a.ts:2 は diff の追加行
    // 空の Map を渡す: 内部パースが走っていれば kept になりこの findings では不一致になる。
    // 渡した Map が使われるなら file_not_in_diff として filteredOut へ落ちて match する。
    const withEmptyMap = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 2, reason: "file_not_in_diff" }],
      }),
      { changedLinesMap: new Map(), untrackedFiles: [] },
    );
    expect(withEmptyMap.match).toBe(true);

    // 解析済みの正しい Map では従来どおり kept として扱われる（内部パースと同一の判定）
    const parsed = parseDiffChangedLines(diff);
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(raw), {
        changedLinesMap: parsed,
        untrackedFiles: [],
      }).match,
    ).toBe(true);
    expect(
      auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] }).match,
    ).toBe(false);
  });

  test("diff.txt が無ければ機械照合できず fail", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, undefined, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("diff.txt");
  });

  test("filteredOut のスキーマ不正は TypeError にせず reasons に積んで fail する", () => {
    const raw = [finding({ position: { side: "new", line: 99 } })];

    // items: [null] は filteredKey が null アクセスで落ちる形（旧実装は TypeError）
    const nullItem = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], { count: 1, items: [null as never] }),
      { untrackedFiles: [] },
    );
    expect(nullItem.match).toBe(false);
    expect(nullItem.reasons.join("\n")).toContain("filteredOut.items[0]");
    expect(nullItem.reasons.join("\n")).toContain("オブジェクトではありません");

    // filteredOut 自体がオブジェクトでない
    const notObject = auditFindingsNormalization(
      raw,
      diff,
      {
        ...findingsJson([]),
        filteredOut: [1],
      } as unknown as FindingsJson,
      { untrackedFiles: [] },
    );
    expect(notObject.match).toBe(false);
    expect(notObject.reasons.join("\n")).toContain("filteredOut");

    // items が配列でない
    const notArray = auditFindingsNormalization(
      raw,
      diff,
      {
        ...findingsJson([]),
        filteredOut: { count: 1, items: "x" },
      } as unknown as FindingsJson,
      { untrackedFiles: [] },
    );
    expect(notArray.match).toBe(false);
    expect(notArray.reasons.join("\n")).toContain("items が配列ではありません");

    // reason が契約外・count が整数でない
    const badReason = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "tampered" }],
      }),
      { untrackedFiles: [] },
    );
    expect(badReason.match).toBe(false);
    expect(badReason.reasons.join("\n")).toContain("reason が不正");

    const badCount = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], { count: "1" as never, items: [null as never] }),
      { untrackedFiles: [] },
    );
    expect(badCount.match).toBe(false);
    expect(badCount.reasons.join("\n")).toContain("count が整数ではありません");
  });

  test("diff.txt に untracked の欠落があれば fail（打ち切られた差分を SoT にしない）", () => {
    const raw = [finding()];
    // untracked 一覧の 1 件が diff.txt に現れない = head 等による打ち切りを模す
    const audit = auditFindingsNormalization(raw, diff, findingsJson(raw), {
      untrackedFiles: ["src/a.ts", "src/missing.ts"],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("src/missing.ts");
    expect(audit.reasons.join("\n")).toContain("欠落");

    // 欠落が無ければ match
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(raw), { untrackedFiles: ["src/a.ts"] })
        .match,
    ).toBe(true);
  });

  test("diff.txt の truncate マーカーは fail（表示用 truncate と SoT の混同検出）", () => {
    const raw = [finding()];
    const truncated = `${diff}\n[... truncated: 4999 lines omitted]\n`;
    const audit = auditFindingsNormalization(raw, truncated, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("truncate マーカー");

    // 差分内容に `+[... truncated...` として現れる場合はマーカーではない（行頭一致のみ）
    const contentLine = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1 @@
+[... truncated: 4999 lines omitted]`;
    const notMarker = auditFindingsNormalization(raw, contentLine, findingsJson([]), {
      untrackedFiles: ["src/a.ts"],
    });
    expect(notMarker.reasons.join("\n")).not.toContain("truncate マーカー");
  });
});

describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("quoteGitPathForDiff: git の C-quote 写像（非 ASCII・制御文字・引用符のみ）", () => {
    expect(quoteGitPathForDiff("src/plain.ts")).toBe("src/plain.ts");
    expect(quoteGitPathForDiff("src/my file.ts")).toBe("src/my file.ts");
    expect(quoteGitPathForDiff('src/quote"file.ts')).toBe('src/quote\\"file.ts');
    expect(quoteGitPathForDiff("src/tab\tfile.ts")).toBe("src/tab\\tfile.ts");
    expect(quoteGitPathForDiff("docs/日本語.md")).toBe(
      "docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md",
    );
  });

  test("unquoteGitPath: quoteGitPathForDiff の逆写像（非 ASCII・escape、非引用は原文）", () => {
    expect(unquoteGitPath('"docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"')).toBe(
      "docs/日本語.md",
    );
    expect(unquoteGitPath('"my \\"file\\".txt"')).toBe('my "file".txt');
    expect(unquoteGitPath('"tab\\tfile.txt"')).toBe("tab\tfile.txt");
    expect(unquoteGitPath("plain/path.ts")).toBe("plain/path.ts");
    // 壊れた入力でも例外にせず原文を返す（無音クラッシュしない）
    expect(unquoteGitPath('"unterminated')).toBe('"unterminated');
    // 往復で一致する（git の `+++ "b/<quoted>"` と同じく全体を引用符で囲む）
    for (const path of [
      "src/plain.ts",
      "my file.txt",
      'quote"file.txt',
      "tab\tfile.txt",
      "docs/日本語.md",
    ]) {
      const quoted = quoteGitPathForDiff(path);
      if (quoted !== path) {
        expect(unquoteGitPath(`"${quoted}"`)).toBe(path);
      }
    }
  });

  test("parseDiffChangedLines: C-quote された +++ パスを生の filePath へ逆写像する（非 ASCII 回帰）", () => {
    const quotedPath = quoteGitPathForDiff("docs/日本語.md");
    const diff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      `--- "a/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -0,0 +1,2 @@",
      "+追加行1",
      "+追加行2",
    ].join("\n");
    const map = parseDiffChangedLines(diff);
    // レビュアーは生の filePath（docs/日本語.md）を返すため、キーを生パスに統一する
    expect([...map.keys()]).toEqual(["docs/日本語.md"]);
    expect([...map.get("docs/日本語.md")!]).toEqual([1, 2]);

    // core.quotePath=false の生パス形（空白 + 末尾タブ）も同じキーへ正規化する
    const rawDiff = [
      "diff --git a/my file.txt b/my file.txt",
      "--- a/my file.txt\t",
      "+++ b/my file.txt\t",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    expect([...parseDiffChangedLines(rawDiff).keys()]).toEqual(["my file.txt"]);

    // 引用符入りパス（core.quotePath=false でも \" escape で引用される）の回帰
    const quoteDiff = [
      'diff --git "a/my \\"file\\".txt" "b/my \\"file\\".txt"',
      '+++ "b/my \\"file\\".txt"\t',
      "@@ -0,0 +1 @@",
      "+y",
    ].join("\n");
    expect([...parseDiffChangedLines(quoteDiff).keys()]).toEqual(['my "file".txt']);
  });

  test("auditFindingsNormalization: C-quote パス上の指摘を file_not_in_diff で無音除外しない", () => {
    const quotedPath = quoteGitPathForDiff("docs/日本語.md");
    const diff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -0,0 +1 @@",
      "+追加行",
    ].join("\n");
    const finding = {
      axis: "req-1",
      severity: "should",
      detail: "非 ASCII パスの指摘",
      filePath: "docs/日本語.md",
      position: { side: "new", line: 1 },
    };
    const findingsJsonValue: FindingsJson = {
      round: 1,
      width: "medium",
      depth: "medium",
      findings: [finding] as never,
      counts: { must: 0, should: 1, want: 0 },
    };
    const audit = auditFindingsNormalization([finding], diff, findingsJsonValue, {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(true);
    expect(audit.reasons).toEqual([]);
  });

  test("diffContainsUntrackedFile: +++ / diff --git / C-quote / 生パスの各形を行一致で検出する", () => {
    const textDiff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+line",
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.ts")).toBe(true);
    // 部分一致では拾わない（"src/new.ts" が "src/new.ts2" に誤ヒットしない）
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.ts2")).toBe(false);
    expect(diffContainsUntrackedFile(indexDiffText(textDiff), "src/new.tsx")).toBe(false);

    // 空・バイナリファイルは +++ 行が無く diff --git 見出しだけで現れる
    const binaryDiff = [
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(binaryDiff), "bin.dat")).toBe(true);

    // 空白入りパスは +++ 行にタブが付く
    const spaceDiff = ["diff --git a/my file.txt b/my file.txt", "+++ b/my file.txt\t"].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(spaceDiff), "my file.txt")).toBe(true);

    // 非 ASCII は C-quote された見出しを候補にする
    const quoted = quoteGitPathForDiff("日本語.txt");
    const quotedDiff = [
      `diff --git "a/${quoted}" "b/${quoted}"`,
      "--- /dev/null",
      `+++ "b/${quoted}"`,
    ].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(quotedDiff), "日本語.txt")).toBe(true);

    // 引用符入りは C-quote + 末尾タブの形も検出する（+++ "b/my \"file\".txt"<TAB>）
    const quotePath = 'my "file".txt';
    const quoteQuoted = quoteGitPathForDiff(quotePath);
    const quoteDiff = [`+++ "b/${quoteQuoted}"\t`].join("\n");
    expect(diffContainsUntrackedFile(indexDiffText(quoteDiff), quotePath)).toBe(true);
  });

  test("findMissingUntrackedFiles / diffCompletenessReasons: 欠落とマーカーを検出する", () => {
    const diff = ["diff --git a/kept.ts b/kept.ts", "+++ b/kept.ts", "@@ -0,0 +1 @@", "+x"].join(
      "\n",
    );
    expect(findMissingUntrackedFiles(indexDiffText(diff), ["kept.ts"])).toEqual([]);
    expect(findMissingUntrackedFiles(indexDiffText(diff), ["kept.ts", "dropped.ts"])).toEqual([
      "dropped.ts",
    ]);

    expect(diffCompletenessReasons(diff, ["kept.ts"])).toEqual([]);

    const marker = `${diff}\n[... truncated: 5000 lines omitted]\n`;
    const markerReasons = diffCompletenessReasons(marker, ["kept.ts"]);
    expect(markerReasons.join("\n")).toContain("truncate マーカー");

    // 差分本文の `+ [... truncated...`（行頭が +）はマーカーではない
    const content = `${diff}\n+[... truncated: 3 lines omitted]`;
    expect(diffCompletenessReasons(content, ["kept.ts"])).toEqual([]);

    const missingReasons = diffCompletenessReasons(diff, ["kept.ts", "dropped.ts"]);
    expect(missingReasons.join("\n")).toContain("dropped.ts");
    expect(missingReasons.join("\n")).toContain("1 件欠落");
  });

  test("indexDiffText: 行配列と行 Set を 1 回の split で共有する（マーカー検査と untracked 突合で同一結果）", () => {
    const index = indexDiffText("a\nb\na");
    expect(index.lines).toEqual(["a", "b", "a"]);
    expect(index.lineSet.has("a")).toBe(true);
    expect(index.lineSet.has("c")).toBe(false);
    // 重複行は Set で 1 件に畳まれるが、行配列（マーカー走査用）は元の行数・順序を保つ
    expect(index.lineSet.size).toBe(2);
    expect(index.lines.length).toBe(3);
  });

  test("listUntrackedFiles: -z の NUL 区切りを分解し、失敗は理由付きで返す", () => {
    const binDir = newSessionDir();
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const scriptPath = path.join(binDir, "git");
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nprintf 'a.ts\\0dir/b b.ts\\0'\n`);
      rmSync(scriptPath, { force: true });
      symlinkSync(ensureFakeScriptRunner(), scriptPath);

      const result = listUntrackedFiles();
      expect("files" in result).toBe(true);
      expect("files" in result ? result.files : []).toEqual(["a.ts", "dir/b b.ts"]);

      // 失敗時は空一覧へ縮退せず error を返す
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nexit 128\n`);
      const failed = listUntrackedFiles();
      expect("error" in failed).toBe(true);
      expect("error" in failed ? failed.error : "").toContain("ls-files");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("countDiffLinesByPath: 追加/削除/リネーム/バイナリ/モード変更をファイル別に集計する", () => {
    const diff = [
      "diff --git a/mod.txt b/mod.txt",
      "--- a/mod.txt",
      "+++ b/mod.txt",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "-old",
      "+new",
      "+added",
      "diff --git a/del.txt b/del.txt",
      "deleted file mode 100644",
      "--- a/del.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 60%",
      "rename from old.txt",
      "rename to renamed.txt",
      "--- a/old.txt",
      "+++ b/renamed.txt",
      "@@ -1 +1,2 @@",
      " keep",
      "+more",
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
      "diff --git a/mode.sh b/mode.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const counts = countDiffLinesByPath(diff);
    expect(counts.get("mod.txt")).toEqual({ added: 2, deleted: 1 });
    expect(counts.get("del.txt")).toEqual({ added: 0, deleted: 1 });
    expect(counts.get("new.txt")).toEqual({ added: 2, deleted: 0 });
    // リネームは new 側パス（numstat の new 側パス）へ集約する
    expect(counts.get("renamed.txt")).toEqual({ added: 1, deleted: 0 });
    // バイナリ・モード変更のみのファイルは +/- 行を持たない
    expect(counts.has("bin.dat")).toBe(false);
    expect(counts.has("mode.sh")).toBe(false);
  });

  test("countDiffLinesByPath: hunk 内の +++ / --- 始まりの内容行をヘッダと誤認しない", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1,2 @@",
      "+++ content",
      "--- content",
    ].join("\n");
    expect(countDiffLinesByPath(diff).get("f.txt")).toEqual({ added: 1, deleted: 1 });
  });

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

  test("parseDiffNumstat: 契約外の出力は null を返す（fail-closed）", () => {
    expect(parseDiffNumstat("garbage")).toBeNull();
    // リネームの 2 パス形式でパスが欠落している
    expect(parseDiffNumstat("1\t0\t")).toBeNull();
  });

  test("diffNumstatReasons: 一致は空、ファイル欠落・行数不一致・バイナリ見出し欠落を検出する", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "+added",
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
    ].join("\n");
    const entries: DiffNumstatEntry[] = [
      { path: "src/a.ts", added: 1, deleted: 0 },
      { path: "bin.dat", added: null, deleted: null },
    ];
    expect(diffNumstatReasons(diff, entries)).toEqual([]);

    const missing = diffNumstatReasons(diff, [
      ...entries,
      { path: "src/dropped.ts", added: 1, deleted: 0 },
    ]);
    expect(missing.join("\n")).toContain("src/dropped.ts");
    expect(missing.join("\n")).toContain("欠落");

    const mismatched = diffNumstatReasons(diff, [{ path: "src/a.ts", added: 5, deleted: 0 }]);
    expect(mismatched.join("\n")).toContain("一致しません");
    expect(mismatched.join("\n")).toContain("+5/-0");

    // バイナリは行数を持たないが、ファイル見出しの出現だけは検証する
    const withoutBinary = diff
      .split("\n")
      .filter((line) => !line.startsWith("diff --git a/bin.dat"))
      .join("\n");
    expect(diffNumstatReasons(withoutBinary, entries).join("\n")).toContain("bin.dat");
  });

  test("missingStagedFilesReasons: staged の追加/変更/削除/リネームをファイル見出しで突合する", () => {
    const diff = [
      "diff --git a/src/mod.ts b/src/mod.ts",
      "--- a/src/mod.ts",
      "+++ b/src/mod.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "+x",
      "diff --git a/src/del.ts b/src/del.ts",
      "deleted file mode 100644",
      "--- a/src/del.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    expect(missingStagedFilesReasons(diff, ["src/mod.ts", "src/del.ts", "src/new.ts"])).toEqual([]);

    const reasons = missingStagedFilesReasons(diff, ["src/mod.ts", "src/staged-new.ts"]);
    expect(reasons.join("\n")).toContain("src/staged-new.ts");
    expect(reasons.join("\n")).toContain("staged");
  });

  test("diffContainsPath: 削除（--- a/…）とリネーム（rename to …）の見出し形も検出する", () => {
    const deletion = ["diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null"].join(
      "\n",
    );
    expect(diffContainsPath(indexDiffText(deletion), "gone.txt")).toBe(true);

    const rename = [
      "diff --git a/old.txt b/new.txt",
      "rename from old.txt",
      "rename to new.txt",
    ].join("\n");
    expect(diffContainsPath(indexDiffText(rename), "new.txt")).toBe(true);
    expect(diffContainsPath(indexDiffText(rename), "old.txt")).toBe(true);
    expect(diffContainsPath(indexDiffText(rename), "other.txt")).toBe(false);
  });

  test("listStagedFiles: staged のみを返し、リネームの元パスと未追跡を読み飛ばす", () => {
    const binDir = newSessionDir();
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const scriptPath = path.join(binDir, "git");
      // porcelain v1 -z: `XY <path>\0[<orig>\0]`。X が空白/`?` の作業ツリー変更は staged ではない。
      writeFileSync(
        `${scriptPath}.body`,
        `#!/bin/sh
printf 'M  src/mod.ts\\0A  src/new.ts\\0?? src/untracked.ts\\0 M src/unstaged.ts\\0R  src/renamed.ts\\0src/old.ts\\0'
`,
      );
      rmSync(scriptPath, { force: true });
      symlinkSync(ensureFakeScriptRunner(), scriptPath);

      const result = listStagedFiles();
      expect("files" in result).toBe(true);
      expect("files" in result ? result.files : []).toEqual([
        "src/mod.ts",
        "src/new.ts",
        "src/renamed.ts",
      ]);

      // 失敗時は空一覧へ縮退せず error を返す
      writeFileSync(`${scriptPath}.body`, `#!/bin/sh\nexit 128\n`);
      const failed = listStagedFiles();
      expect("error" in failed).toBe(true);
      expect("error" in failed ? failed.error : "").toContain("status");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("validateEffort (mt-review-diff / mt-plan-run 共有の effort 検証)", () => {
  const valid = { width: "medium", depth: "medium", base: "main", round: 1 };

  test("契約を満たす effort は pass", () => {
    expect(validateEffort(valid)).toEqual({
      status: "pass",
      width: "medium",
      depth: "medium",
      round: 1,
      overflow: false,
    });
  });

  test("round > LIMIT は fail、allowRoundOverflow で pass（overflow=true）", () => {
    const over = { ...valid, round: REVIEW_ROUND_LIMIT + 1 };
    const failed = validateEffort(over);
    expect(failed.status).toBe("fail");
    expect(failed.status === "fail" ? failed.reasons.join("\n") : "").toContain(
      "round limit exceeded",
    );
    expect(validateEffort(over, { allowRoundOverflow: true })).toEqual({
      status: "pass",
      width: "medium",
      depth: "medium",
      round: REVIEW_ROUND_LIMIT + 1,
      overflow: true,
    });
  });

  test("width / depth / base の契約は allowRoundOverflow でも同じ fail を返す", () => {
    const invalids: Array<Record<string, unknown>> = [
      { ...valid, width: "super", round: 4 },
      { ...valid, depth: "super", round: 4 },
      { ...valid, base: "bad ref", round: 4 },
    ];
    for (const invalid of invalids) {
      const result = validateEffort(invalid, { allowRoundOverflow: true });
      expect(result.status).toBe("fail");
    }
  });

  test("JSON オブジェクトでなければ error", () => {
    expect(validateEffort(undefined).status).toBe("error");
    expect(validateEffort([valid]).status).toBe("error");
  });

  test("round は 1 以上の整数必須（欠落・0・小数・文字列は fail。無音の 1 フォールバックをしない）", () => {
    // round=0 / 2.5 / "3" / 欠落は、collect_context check / advanceReviewRound と
    // 同じ判定（fail）になる。round 未指定を 1 にフォールバックすると、同じ effort.json が
    // mt-review-diff では pass、mt-plan-run では fail という経路差が生まれる。
    for (const round of [0, -1, 2.5, "3", undefined, null]) {
      const result = validateEffort({ width: "low", depth: "max", round });
      expect(result.status).toBe("fail");
      if (result.status === "fail") {
        expect(result.reasons.join("\n")).toContain("round");
      }
    }
    // 境界値: round=1 は pass
    expect(validateEffort({ width: "low", depth: "max", round: 1 }).status).toBe("pass");
  });
});

describe("runDifitCommand (stderr / maxBuffer)", () => {
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

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  test("exit 1 でも stdout / stderr を捨てずに回収する（ゲートブロック + 警告の両取り）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
printf '%s\\n' '{"passes":false,"blocking_threads":[]}'
printf '%s\\n' 'mt difit: 警告: ブラウザの diff 選択が起動時と異なります' >&2
exit 1`,
    );

    const result = runDifitCommand(["check", "--dry-run"]);

    expect(result.stdout).toContain('"passes":false');
    expect(result.stderr).toContain("ブラウザの diff 選択が起動時と異なります");
  });

  test("spawn 失敗（mt 不在）は DifitSpawnError で原因（ENOENT 等）を報告する（空出力に縮退させない）", () => {
    process.env.PATH = binDir; // mt / git など何も置かない
    let caught: unknown;
    try {
      runDifitCommand(["threads", "--json"]);
    } catch (error) {
      caught = error;
    }
    expect(isDifitSpawnError(caught)).toBe(true);
    expect((caught as Error).message).toContain("mt difit threads --json");
    expect((caught as Error).message).toContain("spawn 失敗");
    expect((caught as Error).message).toContain("ENOENT");
  });

  test("既定 1 MiB を超える threads 出力（2 MiB body）でも切り詰めずに取得できる", () => {
    const bodyBytes = 2 * 1024 * 1024;
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
BODY=$(head -c ${bodyBytes} /dev/zero | tr '\\0' 'a')
printf '{"passes":true,"blocking_threads":[],"threads":[{"id":"t1","filePath":"src/a.ts","position":{"side":"new","line":1},"taxonomy":"issue","blocking":false,"body":"%s","author":null,"replies":[]}]}\\n' "$BODY"
exit 0`,
    );

    const result = fetchDifitThreads();

    expect(result.output).toBeDefined();
    expect(result.output!.threads[0].body.length).toBeGreaterThanOrEqual(bodyBytes);
  });

  test("maxBuffer 超過は DifitOutputTooLargeError で原因を報告する（切り詰め断片を返さない）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
head -c ${DIFIT_MAX_BUFFER_BYTES + 1024} /dev/zero | tr '\\0' 'a'
exit 0`,
    );

    let caught: unknown;
    try {
      fetchDifitThreads();
    } catch (error) {
      caught = error;
    }
    expect(isDifitOutputTooLargeError(caught)).toBe(true);
    expect((caught as Error).message).toContain("maxBuffer");
  });

  test("timeout 以内に応答しない mt は DifitTimeoutError で理由を報告する（同期実行を無制限にブロックしない）", () => {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
sleep 5
printf '%s\\n' '{"passes":true,"blocking_threads":[]}'
exit 0`,
    );

    let caught: unknown;
    const startedAt = Date.now();
    try {
      runDifitCommand(["done"], 200);
    } catch (error) {
      caught = error;
    }
    expect(isDifitTimeoutError(caught)).toBe(true);
    expect((caught as Error).message).toContain("timeout");
    // timeout を待たずに kill されて戻る（テストは数秒で完了する）
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe("difitCommandFailureMessage (4 サイト共通の振り分け)", () => {
  test("difit の 3 エラー型は理由メッセージを返す（型ごとの原因を失わない）", () => {
    expect(
      difitCommandFailureMessage(new DifitOutputTooLargeError(["threads", "--json"])),
    ).toContain("maxBuffer");
    expect(difitCommandFailureMessage(new DifitTimeoutError(["done"]))).toContain("timeout");
    expect(
      difitCommandFailureMessage(new DifitSpawnError(["check", "--dry-run"], new Error("ENOENT"))),
    ).toContain("spawn 失敗");
  });

  test("対象外の例外は undefined を返す（呼び出し元が rethrow する契約）", () => {
    expect(difitCommandFailureMessage(new Error("unexpected"))).toBeUndefined();
    expect(difitCommandFailureMessage(undefined)).toBeUndefined();
    expect(difitCommandFailureMessage({ code: "ETIMEDOUT" })).toBeUndefined();
  });
});

describe("isProcessAlive (ESRCH のみ死亡・それ以外は生存)", () => {
  test("存在しない pid は false（ESRCH）", () => {
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  test("EPERM（プロセスは存在するが権限がない）は true（孤児を見逃さない fail-closed）", () => {
    const original = process.kill;
    (process as unknown as { kill: unknown }).kill = () => {
      const error = new Error("kill EPERM") as Error & { code: string };
      error.code = "EPERM";
      throw error;
    };
    try {
      expect(isProcessAlive(1)).toBe(true);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
    }
  });
});

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

describe("cleanupDifitSession (done + state 消失 + pid 終了の検証)", () => {
  let binDir: string;
  let repoRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = newSessionDir();
    repoRoot = path.join(binDir, "repo");
    mkdirSync(path.join(repoRoot, ".difit"), { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    rmSync(scriptPath, { force: true });
    symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  function fakeGit(): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${repoRoot}" && exit 0
exit 1`,
    );
  }

  function writeState(pid: number): void {
    writeFileSync(
      path.join(repoRoot, ".difit", "difit-review.json"),
      JSON.stringify({ port: 4966, pid, comments: [], difit_args: [], tab: null }),
    );
  }

  function fakeMtDone(options: { removeState?: boolean; json?: string } = {}): void {
    const lines = [`[ "$1" = "difit" ] || exit 64`, `[ "$2" = "done" ] || exit 64`];
    if (options.removeState ?? true) {
      lines.push(`rm -f "${repoRoot}/.difit/difit-review.json"`);
    }
    lines.push(
      `printf '%s\\n' '${options.json ?? '{"passes":true,"blocking_threads":[]}'}'`,
      "exit 0",
    );
    writeScript("mt", lines.join("\n"));
  }

  test("done が state を削除し、done 前 pid が終了していれば pass（done 出力と stderr を返す）", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone();
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("pass");
    expect(cleanup.done?.passes).toBe(true);
    expect(cleanup.reasons.join("\n")).toContain("pid=2147483647");
    expect(existsSync(path.join(repoRoot, ".difit", "difit-review.json"))).toBe(false);
  });

  test("done 後も difit プロセスが生存していれば error（orphan 検出）", () => {
    fakeGit();
    writeState(process.pid);
    fakeMtDone();
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("生存");
  });

  test("done 後も state が残っていれば error", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone({ removeState: false });
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("残っています");
  });

  test("done が契約出力を返さなければ error（後始末を検証できない）", () => {
    fakeGit();
    writeState(2147483647);
    fakeMtDone({ json: "not json" });
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("後始末出力");
  });

  test("done の spawn 失敗（mt 不在）は DifitSpawnError の理由で error を返す（原因を消さない）", () => {
    fakeGit();
    writeState(2147483647);
    process.env.PATH = binDir; // mt を PATH から外す（git fake のみ残す）
    const cleanup = cleanupDifitSession();
    expect(cleanup.status).toBe("error");
    expect(cleanup.reasons.join("\n")).toContain("spawn 失敗");
  });
});

describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  /// `mt difit check` / `threads --json` の stdout 契約として drift を解釈する。
  const parseDrift = (selectionDrift: unknown) =>
    parseDifitCheck(
      JSON.stringify({ passes: true, blocking_threads: [], selection_drift: selectionDrift }),
    );

  test("Rust の selection_drift 契約（detection / expected / current）を三値で取り込む", () => {
    expect(
      parseDrift({
        detection: "detected",
        expected: { base: "a", target: "b", baseMode: "merge-base" },
        current: { base: "c", target: "d" },
      })!.selection_drift,
    ).toEqual({
      detection: "detected",
      expected: { base: "a", target: "b", baseMode: "merge-base" },
      current: { base: "c", target: "d" },
    });
    expect(
      parseDrift({
        detection: "none",
        expected: { base: "a", target: "b" },
        current: { base: "a", target: "b" },
      })!.selection_drift,
    ).toEqual({
      detection: "none",
      expected: { base: "a", target: "b" },
      current: { base: "a", target: "b" },
    });
    // probe 失敗時は current が null（検知不能）。drift 情報は expected のみ保持する
    expect(
      parseDrift({
        detection: "unavailable",
        expected: { base: "a", target: "b" },
        current: null,
      })!.selection_drift,
    ).toEqual({ detection: "unavailable", expected: { base: "a", target: "b" } });
  });

  test("旧形式（boolean / {detected}）や未知の detection は selection_drift_error に理由を記録する", () => {
    expect(parseDrift(true)!.selection_drift).toBeUndefined();
    expect(parseDrift(true)!.selection_drift_error).toContain("オブジェクト");
    expect(parseDrift({ detected: true })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detected: true })!.selection_drift_error).toContain("detection");
    expect(parseDrift({ detection: "drifted" })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detection: "drifted" })!.selection_drift_error).toContain("drifted");
    // フィールド欠落（done など drift を省く経路）は error マーカーを立てない
    expect(
      parseDifitCheck('{"passes":true,"blocking_threads":[]}')!.selection_drift,
    ).toBeUndefined();
    expect(
      parseDifitCheck('{"passes":true,"blocking_threads":[]}')!.selection_drift_error,
    ).toBeUndefined();
  });

  test("describeDifitSelectionDrift: detected はセレクタ復旧、unavailable は検知不能の復旧手順を返す", () => {
    const detected = describeDifitSelectionDrift({
      detection: "detected",
      expected: { base: "a", target: "b" },
      current: { base: "c", target: "d" },
    });
    expect(detected).toContain("リビジョンセレクタ");
    expect(detected).toContain("起動時の選択");

    const unavailable = describeDifitSelectionDrift({
      detection: "unavailable",
      expected: { base: "a", target: "b" },
    });
    expect(unavailable).toContain("検知不能");
    expect(unavailable).toContain("probe 失敗");
    expect(unavailable).toContain("mt difit start <base-branch>");
  });

  // Rust の DriftDetection 三値と TS パーサーの受理集合を突合する
  // （スキーマ変更・enum 追加時に TS 側の追従漏れを検知する）。
  test("Rust の DriftDetection 三値と TS パーサーの受理集合が一致する", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../..");
    const checkRs = readFileSync(path.join(repoRoot, "src/difit/check.rs"), "utf-8");
    const enumBody = /enum DriftDetection \{([\s\S]*?)\n\}/.exec(checkRs)?.[1];
    expect(enumBody).toBeDefined();
    const variants = (enumBody ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Za-z0-9]*,$/.test(line))
      .map((line) => line.slice(0, -1).toLowerCase())
      .sort();
    expect(variants).toEqual(["detected", "none", "unavailable"]);

    // serde の lowercase 変換が前提（rename_all = "lowercase"）
    const enumIndex = checkRs.indexOf("enum DriftDetection");
    expect(checkRs.slice(Math.max(0, enumIndex - 300), enumIndex)).toContain(
      'rename_all = "lowercase"',
    );

    // 全バリアントを TS パーサーが受理し、未知値は error マーカー（fail-closed）
    for (const detection of variants) {
      expect(
        parseDrift({ detection, expected: { base: "a", target: "b" } })!.selection_drift,
      ).toEqual(expect.objectContaining({ detection }));
    }
    expect(parseDrift({ detection: "unknown" })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detection: "unknown" })!.selection_drift_error).toContain("unknown");
  });

  // README に記載された threads --json の出力例（wire 形状）をパーサーがそのまま受理する
  test("src/README.md の selection_drift 出力例をそのまま解釈できる", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../..");
    const readme = readFileSync(path.join(repoRoot, "src/README.md"), "utf-8");
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const driftBlock = blocks.find((block) => block.includes('"selection_drift"'));
    expect(driftBlock).toBeDefined();
    const parsed = JSON.parse(driftBlock!) as { selection_drift?: unknown };
    expect(parseDrift(parsed.selection_drift)!.selection_drift).toEqual({
      detection: "detected",
      expected: { base: "abc1234", target: "def5678", baseMode: "merge-base" },
      current: { base: "9999999", target: "def5678" },
    });
  });

  test("difitStderrReasons は空 stderr を落とし、非空行を理由行へ整形する", () => {
    expect(difitStderrReasons("")).toEqual([]);
    expect(difitStderrReasons("  \n\n")).toEqual([]);
    expect(difitStderrReasons("warn: drift\n\nerror: identity\n")).toEqual([
      "mt difit stderr: warn: drift",
      "mt difit stderr: error: identity",
    ]);
  });
});

// severity / taxonomy / want のトークン契約は、TS の生成側（formatReviewComment）と
// Rust の分類側（src/difit/gate.rs の classify_body / is_want）の 2 言語にまたがる。
// DriftDetection parity と同様に gate.rs から認識トークンのリテラルを抽出し、
// 生成側が `·` 区切りヘッダで同じトークンを出力することを固定する（写像ドリフト検知）。
describe("formatReviewComment / gate.rs トークン parity", () => {
  /// gate.rs の `header_has_token(body, "<token>")` 呼び出しからリテラルを抽出する。
  function extractGateTokens(): string[] {
    const repoRoot = path.resolve(import.meta.dir, "../../../..");
    const gateRs = readFileSync(path.join(repoRoot, "src/difit/gate.rs"), "utf-8");
    const tokens = [...gateRs.matchAll(/header_has_token\(body, "([^"]+)"\)/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    return tokens;
  }

  /// gate.rs の header_tokens と同じ `·` 区切り（`**` を外して trim）で
  /// formatReviewComment のヘッダ行をトークン列にする。
  function headerTokens(body: string): string[] {
    const header = body.split("\n")[0].trim();
    return header
      .replace(/^\*\*/, "")
      .replace(/\*\*$/, "")
      .trim()
      .split("·")
      .map((token) => token.trim());
  }

  test("gate.rs の認識トークン集合は 🐛 issue / 🙋 question / 💡 want の 3 つ", () => {
    const tokens = [...new Set(extractGateTokens())];
    const expected = ["🐛 issue", "🙋 question", "💡 want"];
    expect(tokens.length).toBe(expected.length);
    for (const token of expected) {
      expect(tokens).toContain(token);
    }
  });

  test("severity ごとに gate.rs が認識する taxonomy / want トークンを `·` 区切りで出力する", () => {
    const make = (severity: "must" | "should" | "want") =>
      headerTokens(
        formatReviewComment({
          severity,
          axis: "req-1",
          detail: "d",
          filePath: "src/a.ts",
          line: 1,
        }).body,
      );

    const must = make("must");
    expect(must).toContain("🚨 must");
    expect(must).toContain("🐛 issue");
    expect(must).not.toContain("🙋 question");
    expect(must).not.toContain("💡 want");

    const should = make("should");
    expect(should).toContain("⚠️ should");
    expect(should).toContain("🙋 question");
    expect(should).not.toContain("🐛 issue");
    expect(should).not.toContain("💡 want");

    // want は Rust の is_want が 💡 want を認識し、taxonomy は question（非ブロッキング）になる
    const want = make("want");
    expect(want).toContain("💡 want");
    expect(want).toContain("🙋 question");
    expect(want).not.toContain("🐛 issue");

    // 抽出した全トークンが現行の生成出力のいずれかに現れる（gate.rs への追加を検知）
    const emitted = new Set([...must, ...should, ...want]);
    for (const token of extractGateTokens()) {
      expect(emitted.has(token)).toBe(true);
    }
  });
});

describe("isolateDifitFeedback (difit 由来文面のフェンス隔離)", () => {
  test("行頭#を含む原文を維持したままコードフェンスで囲む", () => {
    const feedback = "## difit の人間フィードバック\n\n### 1. src/a.ts:1 (issue)";
    const isolated = isolateDifitFeedback(feedback);
    expect(isolated.startsWith("```markdown\n")).toBe(true);
    expect(isolated.endsWith("\n```")).toBe(true);
    expect(isolated).toContain(feedback);
  });

  test("``` を含む入力は4連フェンスで囲み早期終了を防ぐ", () => {
    const feedback = "例:\n```\ncode\n```";
    const isolated = isolateDifitFeedback(feedback);
    expect(isolated.startsWith("````markdown\n")).toBe(true);
    expect(isolated.endsWith("\n````")).toBe(true);
    expect(isolated).toContain(feedback);
  });
});

describe("findings.json coverage 併記 (record-only)", () => {
  const base = {
    round: 1,
    width: "medium",
    depth: "medium",
    findings: [],
    counts: { must: 0, should: 0, want: 0 },
  };

  test("coverage なしは valid（旧成果物との後方互換）", () => {
    const result = validateFindingsJson(JSON.stringify(base));
    expect(result.valid).toBe(true);
  });

  test("正しい coverage は valid で parsed に維持される", () => {
    const coverage = {
      reviewers: [
        { index: 1, perspectives: ["req-1", "req-2"] },
        { index: 2, perspectives: ["logic-2"] },
      ],
      diffFiles: ["src/a.ts", "src/b.ts"],
      diffAddedLines: 42,
    };
    const result = validateFindingsJson(JSON.stringify({ ...base, coverage }));
    expect(result.valid).toBe(true);
    expect(result.parsed!.coverage).toEqual(coverage);
  });

  test.each([
    ["reviewers 非配列", { reviewers: "req-1", diffFiles: [], diffAddedLines: 0 }],
    [
      "index 非正整数",
      { reviewers: [{ index: 0, perspectives: ["req-1"] }], diffFiles: [], diffAddedLines: 0 },
    ],
    [
      "perspectives 非配列",
      { reviewers: [{ index: 1, perspectives: "req-1" }], diffFiles: [], diffAddedLines: 0 },
    ],
    ["diffFiles 非配列", { reviewers: [], diffFiles: "src/a.ts", diffAddedLines: 0 }],
    ["diffAddedLines 負数", { reviewers: [], diffFiles: [], diffAddedLines: -1 }],
    ["coverage 非オブジェクト", "coverage-string"],
  ])("不正な coverage は invalid（%s）", (_label, coverage) => {
    const result = validateFindingsJson(JSON.stringify({ ...base, coverage }));
    expect(result.valid).toBe(false);
  });
});

describe("buildReviewCoverage (coverage 正典の組み立て)", () => {
  test("割り当てと差分 Map から reviewers・diffFiles・行数総和を組み立てる", () => {
    const coverage = buildReviewCoverage(
      [[{ id: "req-1" }, { id: "req-2" }], [{ id: "logic-2" }]],
      new Map([
        ["src/b.ts", new Set([3])],
        ["src/a.ts", new Set([1, 2])],
      ]),
    );
    expect(coverage).toEqual({
      reviewers: [
        { index: 1, perspectives: ["req-1", "req-2"] },
        { index: 2, perspectives: ["logic-2"] },
      ],
      diffFiles: ["src/a.ts", "src/b.ts"],
      diffAddedLines: 3,
    });
  });

  test("空の割り当て・空差分はゼロ値になる", () => {
    expect(buildReviewCoverage([], new Map())).toEqual({
      reviewers: [],
      diffFiles: [],
      diffAddedLines: 0,
    });
  });
});

describe("validateVerifyFixJson (verify_fix 報告の検証)", () => {
  test("initial は valid", () => {
    const result = validateVerifyFixJson(JSON.stringify({ status: "initial" }));
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ status: "initial" });
  });

  test("verified は diffChanged と非空 regressionTests が必要", () => {
    const result = validateVerifyFixJson(
      JSON.stringify({
        status: "verified",
        diffChanged: true,
        regressionTests: ["src/a.test.ts"],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test.each([
    ["未作成", undefined],
    ["不正 JSON", "{not-json"],
    ["status 不正", JSON.stringify({ status: "done" })],
    [
      "diffChanged 欠落",
      JSON.stringify({ status: "verified", regressionTests: ["src/a.test.ts"] }),
    ],
    [
      "regressionTests 空",
      JSON.stringify({ status: "verified", diffChanged: true, regressionTests: [] }),
    ],
    [
      "regressionTests 非文字列",
      JSON.stringify({ status: "verified", diffChanged: true, regressionTests: [42] }),
    ],
    ["unfixed 理由欠落", JSON.stringify({ status: "unfixed", reason: "  " })],
  ])("不正な報告は invalid（%s）", (_label, raw) => {
    expect(validateVerifyFixJson(raw as string | undefined).valid).toBe(false);
  });

  test("unfixed は非空 reason で valid", () => {
    const result = validateVerifyFixJson(JSON.stringify({ status: "unfixed", reason: "差分不変" }));
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ status: "unfixed", reason: "差分不変" });
  });
});
