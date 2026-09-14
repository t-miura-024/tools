/**
 * mt-review-diff ワークフローの difit 契約テスト。
 *
 * - 4段再編（normalize_findings → start_difit_review → await_human_review → collect_verdict）の構造
 * - start_difit_review / normalize_findings / collect_verdict の check 契約
 * - await_human_review は mt-review-diff 単独では condition を持たず、常に human gate を提示する
 *   （must>0 の自律段階で skip する 2段階ループは mt-plan-run が condition を override する）
 * - ゲート通過検証は collect_verdict の `mt difit check --dry-run` 突合に一本化する
 * 検証ロジック（effort / findings / verdict / round 上限）は従来どおり mt-plan-run 側の
 * Step import テストと snapshot で担保する。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def, {
  startDifitReviewStep,
  awaitHumanReviewStep,
  collectVerdictStep,
  normalizeFindingsStep,
  WORKING_DIFF_GIT_COMMAND,
  TARGET_RANGE_GIT_COMMAND,
} from "./index.ts";
import {
  buildDifitComments,
  parseDiffChangedLines,
  listDiffNumstat,
  diffNumstatReasons,
  listStagedFiles,
  missingStagedFilesReasons,
} from "../_shared/mt-review-helpers.ts";
import type { CheckCtx } from "tado";

const stepOf = (key: string) => def.steps.find((s) => s.key === key)!;
const stepCheck = (key: string) => stepOf(key).check;

/// fake スクリプトの安定 runner（exec 対象）。
/// macOS は新規の実行ファイルごとに exec スキャン（syspolicyd 等）を行い、高負荷時は
/// spawn が数分ブロックする。テストごとに変わる本体は exec されない `.body` に置き、
/// 実行される scriptPath はこの runner への symlink に固定することで、スキャンを
/// プロセスにつき 1 回に抑え、テストのランダムな長時間ブロックを防ぐ。
const FAKE_SCRIPT_RUNNER = path.join(os.tmpdir(), `mt-fake-script-runner-${process.pid}.sh`);

function ensureFakeScriptRunner(): string {
  if (!fs.existsSync(FAKE_SCRIPT_RUNNER)) {
    fs.writeFileSync(FAKE_SCRIPT_RUNNER, `#!/bin/sh\nexec /bin/sh "$0.body" "$@"\n`);
    fs.chmodSync(FAKE_SCRIPT_RUNNER, 0o755);
  }
  return FAKE_SCRIPT_RUNNER;
}

describe("mt-review-diff step structure (4段再編)", () => {
  it("step キーが 4段再編の順序を維持している", () => {
    expect(def.steps.map((s) => s.key)).toEqual([
      "resolve_effort",
      "collect_context",
      "run_reviewers",
      "normalize_findings",
      "start_difit_review",
      "await_human_review",
      "collect_verdict",
    ]);
  });

  it("Step export が各 step を指している", () => {
    expect(normalizeFindingsStep).toBe(stepOf("normalize_findings"));
    expect(startDifitReviewStep).toBe(stepOf("start_difit_review"));
    expect(awaitHumanReviewStep).toBe(stepOf("await_human_review"));
    expect(collectVerdictStep).toBe(stepOf("collect_verdict"));
  });

  it("difit セッション確保の human_gate を含まない（start task に統合済み）", () => {
    expect(stepOf("start_difit_review").type).toBe("task");
    expect(
      (stepOf("start_difit_review") as unknown as Record<string, unknown>).humanGate,
    ).toBeUndefined();
  });

  it("start_difit_review の prompt が URL 提示と再入時のサーバ再利用を指示する", () => {
    const prompt = (
      startDifitReviewStep.task as { buildPrompt: (ctx: unknown) => string }
    ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });
    expect(prompt).toContain("mt difit start");
    expect(prompt).toContain("difit-comments.json");
    expect(prompt).toContain("再利用");
    // stdout の url を人間と report へ提示する（表示の自動化は行わない）
    expect(prompt).toContain("url");
    expect(prompt).toContain("提示");
    expect(prompt).toContain("difit-start.json");
    // target は difit の第1引数（diff の target）として渡し、第2引数（compare-with=base）と
    // --merge-base で `git diff base...target` 相当の範囲を提示する
    expect(prompt).toContain('"$TARGET" "$BASE" --merge-base');
    expect(prompt).toContain('git diff "$BASE...$TARGET"');
  });

  it("start_difit_review の制約が state 契約を selection で列挙し、撤去済みの tab を含まない", () => {
    const prompt = (
      startDifitReviewStep.task as { buildPrompt: (ctx: unknown) => string }
    ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });
    // 現行 ReviewState は port / pid / comments / difit_args / selection。
    // tab は表示ツール撤去で削除済みで、プロンプトの契約記述に残さない。
    expect(prompt).toContain("port / pid / comments / difit_args / selection");
    expect(prompt).not.toContain("difit_args / tab");
  });

  it("collect_verdict の prompt が選択固定の機械出力（mt difit threads --json）からの verdict 作成を指示する", () => {
    const prompt = (
      collectVerdictStep.task as { buildPrompt: (ctx: unknown) => string }
    ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });
    expect(prompt).toContain("mt difit threads --json");
    expect(prompt).toContain("blocking_threads");
    expect(prompt).toContain("mt difit check");
    expect(prompt).toContain("実行しない");
    expect(prompt).toContain("verdict.json");
    // unpinned な `difit comment get` へ依存しない
    expect(prompt).not.toContain("difit comment get");
  });

  it("collect_verdict の prompt が分類規則を写経せず Rust の機械出力（src/difit/gate.rs）を正とする", () => {
    const prompt = (
      collectVerdictStep.task as { buildPrompt: (ctx: unknown) => string }
    ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });
    expect(prompt).toContain("src/difit/gate.rs");
    expect(prompt).toContain("再分類しない");
    // 旧写経（legacy want の解釈・messages[0] 判定）は残さない
    expect(prompt).not.toContain("無条件 blocking にせず");
    expect(prompt).not.toContain("messages[0]");
    expect(prompt).not.toContain("shared.rs");
  });

  it("collect_verdict の prompt が difit-check.json を report artifacts に登録する（round_limit_gate の presentArtifacts と整合）", () => {
    const prompt = (
      collectVerdictStep.task as { buildPrompt: (ctx: unknown) => string }
    ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });
    // check フェーズが `mt difit check --dry-run` の出力を永続化するファイル。
    // report artifacts に登録しないと round_limit_gate の presentArtifacts から
    // 黙って落ちる（tado の human_gate 提示は DB 登録分しか列挙しない）。
    expect(prompt).toContain('"key":"difit-check.json"');
    expect(prompt).toContain("/tmp/session/difit-check.json");
    expect(prompt).toContain("check フェーズ");
  });
});

describe("mt-review-diff difit checks", () => {
  let tmp: string;
  let binDir: string;
  let sessionDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-review-diff-"));
    binDir = path.join(tmp, "bin");
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(binDir);
    fs.mkdirSync(sessionDir);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    fs.writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    fs.rmSync(scriptPath, { force: true });
    fs.symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  /// git fake: rev-parse --show-toplevel（readDifitReviewState の基点）に加えて、
  /// start check の選択整合検証が使う rev-parse <ref> / merge-base / symbolic-ref に応答する。
  /// 期待選択は base=bbbbbbb（merge-base の先頭 7 文字）、target=aaaaaaa（rev-parse の先頭 7 文字）。
  /// ls-files --others --exclude-standard -z は差分完全性検証の untracked 一覧を、
  /// status --porcelain -z は staged 一覧を、diff --numstat -z は収集範囲の
  /// ファイル別行数を返す（options で欠落・不一致検出テスト用に差し替える。
  /// numstat の path / added / deleted は収集と同一の解決の期待値）。
  function fakeGit(
    options: {
      untracked?: string[];
      staged?: string[];
      numstat?: Array<{ added: number; deleted: number; path: string }>;
      statusFail?: boolean;
      numstatFail?: boolean;
    } = {},
  ): void {
    const untrackedLines = (options.untracked ?? []).map((f) => `printf '%s\\0' '${f}'`).join("\n");
    const stagedLines = (options.staged ?? []).map((f) => `printf '%s\\0' 'A  ${f}'`).join("\n");
    const numstatLines = (options.numstat ?? [])
      .map((e) => `printf '%s\\0' '${e.added}\t${e.deleted}\t${e.path}'`)
      .join("\n");
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${tmp}/repo" && exit 0
if [ "$1" = "rev-parse" ]; then echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0; fi
if [ "$1" = "merge-base" ]; then echo "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; exit 0; fi
if [ "$1" = "symbolic-ref" ]; then echo "origin/main"; exit 0; fi
if [ "$1" = "ls-files" ]; then
${untrackedLines}
exit 0
fi
if [ "$1" = "status" ]; then
${options.statusFail ? "exit 1" : `${stagedLines}\nexit 0`}
fi
if [ "$1" = "diff" ]; then
${options.numstatFail ? "exit 1" : `${numstatLines}\nexit 0`}
fi
exit 1`,
    );
  }

  function writeDifitState(
    pid: number,
    port = 4966,
    selection: Record<string, unknown> | null = {
      base: "bbbbbbb",
      target: ".",
      baseMode: "merge-base",
    },
  ): void {
    const dir = path.join(tmp, "repo", ".difit");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "difit-review.json"),
      JSON.stringify({
        port,
        pid,
        comments: [],
        difit_args: [],
        tab: null,
        ...(selection ? { selection } : {}),
      }),
    );
  }

  /// start check の選択整合検証が読む effort.json。base=origin/main、target なしの既定。
  function writeEffort(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(sessionDir, "effort.json"),
      JSON.stringify({
        width: "medium",
        depth: "medium",
        base: "origin/main",
        round: 1,
        ...overrides,
      }),
    );
  }

  /// `mt difit threads --json`（選択固定・read-only）に応答する fake mt。
  /// 文字列は従来どおり filePath=src/a.ts / line=index+1 の thread として扱い、
  /// オブジェクト指定で filePath / position を差し替えられる（multiset 突合テスト用）。
  /// selectionDrift / stderr で選択ドリフト検知と診断メッセージを模せる。
  /// `selection_drift` は Rust 側で必須のため、未指定時は `none`（一致）を補う
  /// （欠落・解釈不能は `selectionDrift: null` / 旧形式で明示的に模す）。
  /// 引数が `difit threads --json` でなければ exit 64（unpinned CLI への退行検出）。
  function fakeMtDifitThreads(
    threadSpecs: Array<string | { body: string; filePath?: string; position?: unknown }>,
    options: { selectionDrift?: unknown; stderr?: string } = {},
  ): void {
    const threads = threadSpecs.map((spec, index) => {
      const isString = typeof spec === "string";
      return {
        id: `t${index + 1}`,
        filePath: isString ? "src/a.ts" : (spec.filePath ?? "src/a.ts"),
        position: isString
          ? { side: "new", line: index + 1 }
          : "position" in spec
            ? spec.position
            : { side: "new", line: index + 1 },
        taxonomy: "issue",
        blocking: true,
        body: isString ? spec : spec.body,
        author: null,
        replies: [],
      };
    });
    const selectionDrift =
      options.selectionDrift === undefined ? { detection: "none" } : options.selectionDrift;
    const output = {
      passes: false,
      selection: {},
      threads,
      blocking_threads: [],
      ...(selectionDrift === null ? {} : { selection_drift: selectionDrift }),
    };
    const stderrLine = options.stderr ? `printf '%s\\n' '${options.stderr}' >&2` : "";
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${JSON.stringify(output)}'
${stderrLine}
exit 0`,
    );
  }

  /// 選択固定読み取りに応答しない fake mt（サーバ死・選択未記録のシミュレーション）。
  function fakeMtUnresponsive(): void {
    writeScript("mt", "exit 1");
  }

  function writeDifitComments(comments: unknown[]): void {
    fs.writeFileSync(path.join(sessionDir, "difit-comments.json"), JSON.stringify(comments));
  }

  function writeStartJson(json: Record<string, unknown>): void {
    fs.writeFileSync(path.join(sessionDir, "difit-start.json"), `${JSON.stringify(json)}\n`);
  }

  /// `mt difit check --dry-run`（非破壊突合）と `mt difit done`（後始末）に応答する fake mt。
  /// dry-run 以外の check 引数は exit 65 で拒否し、done は呼び出しマーカーを残して
  /// state を削除する（後始末の実挙動を模す）。doneRemoveState=false で削除失敗、
  /// doneJson の passes=false で done 実行時点のゲート変化（ブロック）を模せる。
  /// gateStderr / doneStderr で stderr（選択ドリフト警告・同一性照合エラー）を模せる。
  /// `check --dry-run` は selection_drift を常に含む契約のため、gateJson に無ければ
  /// `none`（一致）を補う（欠落・解釈不能は gateJson 側で明示的に模す）。
  function fakeMtDifitGate(options: {
    gateJson: string;
    gateExit?: number;
    gateStderr?: string;
    doneJson?: string;
    doneStderr?: string;
    doneRemoveState?: boolean;
    doneMkdirState?: boolean;
    /// false で selection_drift の自動補完を止める（欠落契約違反テスト用）。
    injectDrift?: boolean;
  }): void {
    const marker = path.join(tmp, "done-called");
    const gateJson = (() => {
      try {
        const parsed = JSON.parse(options.gateJson) as Record<string, unknown>;
        if ((options.injectDrift ?? true) && parsed.selection_drift === undefined) {
          parsed.selection_drift = { detection: "none" };
        }
        return JSON.stringify(parsed);
      } catch {
        return options.gateJson;
      }
    })();
    const gateStderrLine = options.gateStderr ? `  printf '%s\\n' '${options.gateStderr}' >&2` : "";
    const doneLines = [`  touch '${marker}'`];
    if (options.doneRemoveState ?? true) {
      doneLines.push(`  rm -f "${tmp}/repo/.difit/difit-review.json"`);
    }
    if (options.doneMkdirState) {
      // state を読み取り不能（EISDIR）にして後始末検証の error 分岐を模す
      doneLines.push(`  mkdir -p "${tmp}/repo/.difit/difit-review.json"`);
    }
    if (options.doneStderr) {
      doneLines.push(`  printf '%s\\n' '${options.doneStderr}' >&2`);
    }
    doneLines.push(
      `  printf '%s\\n' '${options.doneJson ?? '{"passes":true,"blocking_threads":[]}'}'`,
      `  exit 0`,
    );
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
if [ "$2" = "check" ]; then
  [ "$3" = "--dry-run" ] || exit 65
  printf '%s\\n' '${gateJson}'
${gateStderrLine}
  exit ${options.gateExit ?? 0}
fi
if [ "$2" = "done" ]; then
${doneLines.join("\n")}
fi
exit 64`,
    );
  }

  function doneCalled(): boolean {
    return fs.existsSync(path.join(tmp, "done-called"));
  }

  function fakeMtDifitCheckNoOutput(): void {
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "check" ] && [ "$3" = "--dry-run" ] && exit 1
exit 64`,
    );
  }

  function makeCtx(overrides: Partial<CheckCtx> = {}): CheckCtx {
    return {
      sessionDir,
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  function writeFindings(round = 1, mustCount = 0): void {
    const findings = Array.from({ length: mustCount }, (_, index) => ({
      axis: "req-1",
      severity: "must",
      detail: `must detail ${index}`,
      filePath: "src/a.ts",
      position: { side: "new", line: index + 1 },
    }));
    fs.writeFileSync(
      path.join(sessionDir, "findings.json"),
      JSON.stringify({
        round,
        width: "medium",
        depth: "medium",
        findings,
        counts: { must: mustCount, should: 0, want: 0 },
      }),
    );
  }

  describe("start_difit_review", () => {
    const threadBody = "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\nreal body";

    it("stdout 契約（port/url/comments）・live state・サーバ上の実コメントが揃えば pass", () => {
      fakeGit();
      writeEffort();
      fakeMtDifitThreads([threadBody]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("comments=1 verified on server");
    });

    it("state が無ければ fail（start 未実行の偽装検出）", () => {
      fakeGit();
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it("stdout 契約に comments が無ければ fail", () => {
      fakeGit();
      fakeMtDifitThreads([]);
      writeDifitState(process.pid);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966" });

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it("state の port と difit-start.json の port が不一致なら fail", () => {
      fakeGit();
      fakeMtDifitThreads([]);
      writeDifitState(process.pid, 4967);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("不一致");
    });

    it("stdout の url が port と整合しないなら fail（別ポートを指す偽装の検出）", () => {
      fakeGit();
      fakeMtDifitThreads([]);
      writeDifitState(process.pid);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4967", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("url=http://localhost:4967");
      expect(result.reasons.join("\n")).toContain("http://localhost:4966");
    });

    it("state が読み取り不能（ディレクトリ化）なら fail（セッション不在と誤診しない）", () => {
      fakeGit();
      fakeMtDifitThreads([]);
      fs.mkdirSync(path.join(tmp, "repo", ".difit", "difit-review.json"), { recursive: true });
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("読み取れません");
      expect(result.reasons.join("\n")).toContain("difit-review.json");
    });

    it("stdout comments と difit-comments.json の件数が不一致なら fail", () => {
      fakeGit();
      fakeMtDifitThreads([threadBody]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 2 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("不一致");
    });

    it("difit-comments.json のコメントがサーバ上に無ければ fail（start 再入の偽装検出）", () => {
      fakeGit();
      // 前ラウンドの古いコメントだけがサーバ上に残っている状況
      fakeMtDifitThreads(["old round comment body"]);
      writeDifitState(process.pid);
      const newBody = "**⚠️ should · 🙋 question · 🧭 logic-3**\n\n**詳細**:\n\nnew round body";
      writeDifitComments([
        { type: "thread", filePath: "src/a.ts", position: { side: "new", line: 1 }, body: newBody },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("multiset");
      expect(result.reasons.join("\n")).toContain("欠落 1 件");
    });

    it("body が一致していても position を改変した注入は fail（multiset 突合）", () => {
      fakeGit();
      // サーバ実体は line=1。注入した difit-comments.json は body 同一で line=5 に改変
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 5 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("multiset");
      expect(result.reasons.join("\n")).toContain("src/a.ts:5");
    });

    it("同一 body 2 件の片方欠落は fail（body の Set 比較では検出できない）", () => {
      fakeGit();
      // サーバ実体は 1 件だけ。注入側は同一 body・同一位置を 2 件要求している
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 3 } }]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 3 },
          body: threadBody,
        },
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 3 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 2 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("欠落 1 件");
    });

    it("サーバ側の余剰（前ラウンド・人間コメント）は許容する（containment 突合）", () => {
      fakeGit();
      writeEffort();
      fakeMtDifitThreads([
        { body: threadBody, position: { side: "new", line: 1 } },
        { body: "前ラウンドの未 resolve コメント", position: { side: "new", line: 2 } },
        { body: "人間のファイルレベルコメント", position: null },
      ]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("pass");
    });

    it("選択固定読み取りが失敗したら fail（unpinned にフォールバックせず選択ドリフトも診断する）", () => {
      fakeGit();
      fakeMtUnresponsive();
      writeDifitState(process.pid);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt difit threads --json");
    });

    it("threads --json の stderr（選択ドリフト警告等）を成功時の reasons にも伝搬する", () => {
      fakeGit();
      writeEffort();
      fakeMtDifitThreads([], {
        stderr: "mt difit: 記録された pid が記録 port を LISTEN していません",
      });
      // threads 出力自体は契約を満たすため、ここでは stderr の伝搬だけを検証する
      writeDifitState(process.pid);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("mt difit stderr:");
      expect(result.reasons.join("\n")).toContain("LISTEN していません");
    });

    it("threads --json が契約違反で stderr にエラーを返す場合は fail 理由へ含める", () => {
      fakeGit();
      writeScript(
        "mt",
        `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' 'mt difit: difit サーバの同一性を確認できません' >&2
exit 1`,
      );
      writeDifitState(process.pid);
      writeDifitComments([]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt difit stderr:");
      expect(result.reasons.join("\n")).toContain("同一性を確認できません");
    });

    it("selection_drift.detection=detected なら fail し、リビジョンセレクタを起動時の選択へ戻す復旧手順を示す", () => {
      fakeGit();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }], {
        selectionDrift: {
          detection: "detected",
          expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
          current: { base: "3333333", target: "4444444" },
        },
      });
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("リビジョンセレクタ");
      expect(result.reasons.join("\n")).toContain("起動時");
      expect(result.reasons.join("\n")).toContain("resolve / reply");
    });

    it("selection_drift.detection=unavailable（probe 失敗）は fail-closed で fail し、復旧手順を示す", () => {
      fakeGit();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }], {
        selectionDrift: {
          detection: "unavailable",
          expected: { base: "1111111", target: "2222222" },
          current: null,
        },
      });
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("検知不能");
      expect(result.reasons.join("\n")).toContain("probe 失敗");
      expect(result.reasons.join("\n")).toContain("mt difit start");
    });

    it("selection_drift.detection=none（probe 成功・一致）は pass する", () => {
      fakeGit();
      writeEffort();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }], {
        selectionDrift: {
          detection: "none",
          expected: { base: "1111111", target: "2222222" },
          current: { base: "1111111", target: "2222222" },
        },
      });
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("pass");
    });

    it("selection_drift フィールド欠落は fail-closed で fail（契約違反。ドリフトなしと混同しない）", () => {
      fakeGit();
      // threads --json は selection_drift を常に含む契約。フィールド自体を出力しない
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }], {
        selectionDrift: null,
      });
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("契約違反");
      expect(result.reasons.join("\n")).toContain("selection_drift");
    });

    it("selection_drift の未知値・旧形式（解釈不能）も fail-closed で fail する", () => {
      fakeGit();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }], {
        selectionDrift: { detected: true },
      });
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("解釈できません");
      expect(result.reasons.join("\n")).toContain("detection");
    });

    it("effort.json が無ければ fail（提示範囲と検証対象の整合を検証できない）", () => {
      fakeGit();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }]);
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("effort.json");
    });

    it("effort.json の target が state.selection に反映されていなければ fail（base 単独起動の乖離検出）", () => {
      fakeGit();
      writeEffort({ target: "feature" });
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }]);
      // target を提示しない起動（単独 base）の state: target は "." のまま
      writeDifitState(process.pid);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("一致しません");
      expect(result.reasons.join("\n")).toContain("--merge-base");
    });

    it("effort.json の target が state.selection に反映されていれば pass（同一範囲の提示）", () => {
      fakeGit();
      writeEffort({ target: "feature" });
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }]);
      // `mt difit start "$TARGET" "$BASE" --merge-base` 相当の state:
      // base=merge-base(target, base)=bbbbbbb、target=rev-parse(target)=aaaaaaa
      writeDifitState(process.pid, 4966, {
        base: "bbbbbbb",
        target: "aaaaaaa",
        baseMode: "merge-base",
      });
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("pass");
    });

    it("state.selection が記録されていなければ fail（選択固定の契約違反）", () => {
      fakeGit();
      writeEffort();
      fakeMtDifitThreads([{ body: threadBody, position: { side: "new", line: 1 } }]);
      writeDifitState(process.pid, 4966, null);
      writeDifitComments([
        {
          type: "thread",
          filePath: "src/a.ts",
          position: { side: "new", line: 1 },
          body: threadBody,
        },
      ]);
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 1 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("selection");
    });

    it("state 不在の fail 復旧案内は effort.json の target を反映する（base 単独起動を案内しない）", () => {
      fakeGit();
      writeEffort({ target: "feature" });
      // .difit/difit-review.json を作らない（セッション不在）
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      // target ありでは difit の第2引数が compare-with=base の起動（target を提示する）
      expect(result.reasons.join("\n")).toContain(
        'mt difit start "feature" "origin/main" --merge-base',
      );
      expect(result.reasons.join("\n")).not.toContain("mt difit start <base-branch>");
    });

    it("mt difit の spawn 失敗（PATH 破損等）は fail 理由に原因（spawn 失敗）を含める", () => {
      fakeGit();
      writeEffort();
      writeStartJson({ port: 4966, url: "http://localhost:4966", comments: 0 });
      writeDifitState(process.pid);
      const originalPath = process.env.PATH;
      process.env.PATH = binDir; // mt を PATH から外す（git fake のみ残す）
      try {
        const result = stepCheck("start_difit_review")(makeCtx());
        expect(result.status).toBe("fail");
        expect(result.reasons.join("\n")).toContain("spawn 失敗");
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe("collect_context (diff.txt 完全性検証)", () => {
    const newFileDiff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+new",
    ].join("\n");

    function writeDiff(content: string): void {
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), content);
    }

    it("untracked が diff.txt に含まれていれば pass する", () => {
      fakeGit({ untracked: ["src/new.ts"] });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("untracked 1 files verified");
    });

    it("untracked が diff.txt に欠落していれば fail（head 等の打ち切り・生成失敗の検出）", () => {
      fakeGit({ untracked: ["src/new.ts", "src/dropped.ts"] });
      // src/dropped.ts の差分が無い = 打ち切りで静かに欠落した状態
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/dropped.ts");
      expect(result.reasons.join("\n")).toContain("欠落");
    });

    it("target ありでは untracked の完全性検査を行わない（diff.txt を提示範囲 base...target に一致させる）", () => {
      // untracked は difit の target 提示（merge-base..target）では表示されないため、
      // diff.txt に混ぜない。欠落していても fail にしない（提示範囲 = 検証対象の不変条件）。
      fakeGit({ untracked: ["src/untracked.ts"] });
      writeEffort({ target: "feature" });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("target=feature");
      expect(result.reasons.join("\n")).toContain("untracked は提示範囲外");
    });

    it("target ありでも truncate マーカーは fail（diff.txt は常に SoT）", () => {
      fakeGit({ untracked: ["src/untracked.ts"] });
      writeEffort({ target: "feature" });
      writeDiff(`${newFileDiff}\n[... truncated: 5000 lines omitted]\n`);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("truncate マーカー");
    });

    it("diff.txt に truncate マーカーがあれば fail（完全な差分が SoT）", () => {
      fakeGit();
      writeDiff(`${newFileDiff}\n[... truncated: 5000 lines omitted]\n`);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("truncate マーカー");
    });

    it("staged 変更が diff.txt に欠落していれば fail（index の取りこぼし検出）", () => {
      // 旧収集（git diff "$BASE...HEAD" + git diff）では index の staged 変更が丸ごと落ちる。
      fakeGit({ staged: ["src/staged.ts"] });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("src/staged.ts");
      expect(reasons).toContain("staged");
    });

    it("staged された新規ファイルが diff.txt に含まれていれば pass する", () => {
      const stagedNewDiff = [
        "diff --git a/src/staged-new.ts b/src/staged-new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/staged-new.ts",
        "@@ -0,0 +1 @@",
        "+staged new",
      ].join("\n");
      fakeGit({
        staged: ["src/staged-new.ts"],
        numstat: [{ added: 1, deleted: 0, path: "src/staged-new.ts" }],
      });
      writeDiff(stagedNewDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("staged 1 files verified");
      expect(result.reasons.join("\n")).toContain("numstat 1 files verified");
    });

    it("git status の取得に失敗したら fail（staged の取りこぼしを検出できない fail-closed）", () => {
      fakeGit({ statusFail: true });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("完全性を検証できません");
    });

    it("numstat とファイル別行数が不一致なら fail（マーカーなしの部分出力検出）", () => {
      fakeGit({ numstat: [{ added: 2, deleted: 0, path: "src/new.ts" }] });
      writeDiff(newFileDiff); // +new の 1 行しかない

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/new.ts");
      expect(result.reasons.join("\n")).toContain("一致しません");
    });

    it("numstat のファイルが diff.txt から丸ごと欠落していれば fail", () => {
      fakeGit({ numstat: [{ added: 1, deleted: 0, path: "src/dropped.ts" }] });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/dropped.ts");
      expect(result.reasons.join("\n")).toContain("欠落");
    });

    it("target ありでも numstat 不一致は fail（提示範囲 base...target の部分出力検出）", () => {
      fakeGit({ numstat: [{ added: 1, deleted: 0, path: "src/dropped.ts" }] });
      writeEffort({ target: "feature" });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/dropped.ts");
    });

    it("git diff --numstat の取得に失敗したら fail（完全性を検証できない fail-closed）", () => {
      fakeGit({ numstatFail: true });
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("完全性を検証できません");
    });

    it("git ls-files の取得に失敗したら fail（完全性を検証できない fail-closed）", () => {
      writeScript("git", "exit 1");
      writeDiff(newFileDiff);

      const result = stepCheck("collect_context")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("完全性を検証できません");
    });

    it("buildPrompt は diff.txt の打ち切り（head）と失敗の握り潰し（|| true）を禁止する", () => {
      const prompt = (
        stepOf("collect_context").task as unknown as { buildPrompt: (ctx: unknown) => string }
      ).buildPrompt({ sessionDir: "/tmp/session", artifacts: [] });

      expect(prompt).not.toContain("head -n 5000");
      expect(prompt).not.toContain("|| true");
      expect(prompt).toContain("完全な差分");
      expect(prompt).toContain("round=1");
      expect(prompt).toContain("truncate");
      // C-quote された非 ASCII パスを SoT に残さない（core.quotePath=false で生パス収集）
      expect(prompt).toContain("-c core.quotePath=false diff");
      // target ありは committed range（base...target）のみを収集し、untracked を追記しない。
      // target なしは merge-base..ワーキングツリー（staged を含む 1 コマンド）で収集する。
      expect(prompt).toContain(TARGET_RANGE_GIT_COMMAND);
      expect(prompt).toContain(WORKING_DIFF_GIT_COMMAND);
      // 収集コマンドとして index を欠く旧 else 分岐を残さない（説明文中の対比表現は許容）
      expect(prompt).not.toContain('else git -c core.quotePath=false diff "$BASE...HEAD"');
      expect(prompt).toContain("git diff --numstat");
      expect(prompt).toContain("git status --porcelain");
      expect(prompt).toContain("ls-files --others --exclude-standard -z");
    });
  });

  describe("normalize_findings (difit-comments 導出検証)", () => {
    // normalize check は diff.txt の完全性照合（untracked 一覧）にも git を使う。
    // untracked なしの fake git を既定にし、欠落検出テストでは上書きする。
    beforeEach(() => {
      fakeGit();
    });

    /// findings の位置（src/a.ts:1..10）を `+` 行として含む diff。
    function writeDiff(): void {
      const added = Array.from({ length: 10 }, (_, i) => `+line${i + 1}`);
      fs.writeFileSync(
        path.join(sessionDir, "diff.txt"),
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -0,0 +1,10 @@",
          ...added,
          "",
        ].join("\n"),
      );
    }

    /// findings.json に加えて reviewer-outputs.json（生 findings）も書く
    /// （normalize_findings check の正規化監査が両者の対応を要求する）。
    function writeFindingsWith(
      findings: Array<Record<string, unknown>>,
      counts: { must: number; should: number; want: number },
    ): string {
      const raw = JSON.stringify({
        round: 1,
        width: "medium",
        depth: "medium",
        findings,
        counts,
      });
      fs.writeFileSync(path.join(sessionDir, "findings.json"), raw);
      fs.writeFileSync(path.join(sessionDir, "reviewer-outputs.json"), JSON.stringify(findings));
      writeDiff();
      return raw;
    }

    const mustFinding = {
      axis: "req-1",
      severity: "must",
      detail: "must detail",
      filePath: "src/a.ts",
      position: { side: "new", line: 1 },
    };
    const shouldFinding = {
      axis: "logic-3",
      severity: "should",
      detail: "should detail",
      filePath: "src/a.ts",
      position: { side: "new", line: 10 },
    };

    it("difit-comments.json が findings から機械導出した内容と一致すれば pass", () => {
      const raw = writeFindingsWith([mustFinding, shouldFinding], {
        must: 1,
        should: 1,
        want: 0,
      });
      writeDifitComments(buildDifitComments(raw));

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("difit-comments derived check ok");
    });

    it("should を落とした部分集合は fail し欠落を可視化する（ゲート迂回の検出）", () => {
      const raw = writeFindingsWith([mustFinding, shouldFinding], {
        must: 1,
        should: 1,
        want: 0,
      });
      const derived = buildDifitComments(raw);
      expect(derived).toHaveLength(2);
      writeDifitComments([derived[0]]);

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/a.ts:10");
      expect(result.reasons.join("\n")).toContain("欠落 1 件");
    });

    it("reviewer-outputs.json の must を findings.json から落としたら fail（集約段の欠落検出）", () => {
      // findings.json は must のみ・counts も自己整合に改変する。生 findings には should が残る。
      const tampered = JSON.stringify({
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [mustFinding],
        counts: { must: 1, should: 0, want: 0 },
      });
      fs.writeFileSync(path.join(sessionDir, "findings.json"), tampered);
      fs.writeFileSync(
        path.join(sessionDir, "reviewer-outputs.json"),
        JSON.stringify([mustFinding, shouldFinding]),
      );
      writeDiff();
      writeDifitComments(buildDifitComments(tampered));

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("正規化と一致しません");
      expect(result.reasons.join("\n")).toContain("欠落 1 件");
      expect(result.reasons.join("\n")).toContain("src/a.ts 10");
    });

    it("difit-comments.json が無ければ fail", () => {
      writeFindingsWith([], { must: 0, should: 0, want: 0 });

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("difit-comments.json");
    });

    it("position.side を改変（new → old）した difit-comments.json は fail", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 });
      const derived = buildDifitComments(raw);
      writeDifitComments([{ ...derived[0], position: { side: "old", line: 1 } }]);

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/a.ts:1");
    });

    it("position なしの余剰コメントはキー生成不能として fail（読み飛ばさない）", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 });
      writeDifitComments([
        ...buildDifitComments(raw),
        { type: "thread", filePath: "src/a.ts", body: "surplus" },
      ]);

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("キー生成不能 1 件");
    });

    it("findings.round が effort.json の round と不一致なら fail（round 継承の契約）", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 }); // round=1
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "medium", depth: "medium", round: 2 }),
      );
      writeDifitComments(buildDifitComments(raw));

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("effort.json の round=2");
    });

    it("findings.round が effort.json の round と一致すれば pass（round 前進を受理する）", () => {
      const raw = JSON.stringify({
        round: 2,
        width: "medium",
        depth: "medium",
        findings: [mustFinding],
        counts: { must: 1, should: 0, want: 0 },
      });
      fs.writeFileSync(path.join(sessionDir, "findings.json"), raw);
      fs.writeFileSync(
        path.join(sessionDir, "reviewer-outputs.json"),
        JSON.stringify([mustFinding]),
      );
      writeDiff();
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "medium", depth: "medium", round: 2 }),
      );
      writeDifitComments(buildDifitComments(raw));

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("round=2");
    });

    it("effort.json の round が不正（0・小数・欠落）なら fail（validateEffort に一本化）", () => {
      for (const effort of [
        { width: "medium", depth: "medium", round: 0 },
        { width: "medium", depth: "medium", round: 1.5 },
        { width: "medium", depth: "medium" },
      ]) {
        const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 }); // round=1
        fs.writeFileSync(path.join(sessionDir, "effort.json"), JSON.stringify(effort));
        writeDifitComments(buildDifitComments(raw));

        const result = stepCheck("normalize_findings")(makeCtx());

        expect(result.status).toBe("fail");
        expect(result.reasons.join("\n")).toContain("round");
      }
    });

    it("diff.txt に untracked の欠落があれば fail（不完全な diff を SoT にしない）", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 });
      writeDifitComments(buildDifitComments(raw));
      // src/dropped.ts は untracked だが diff.txt には現れない（打ち切りを模す）
      fakeGit({ untracked: ["src/dropped.ts"] });

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/dropped.ts");
      expect(result.reasons.join("\n")).toContain("欠落");
    });

    it("target ありでは untracked の欠落検査を行わない（提示範囲 base...target のみが SoT）", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 });
      writeDifitComments(buildDifitComments(raw));
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({
          width: "medium",
          depth: "medium",
          base: "main",
          target: "feature",
          round: 1,
        }),
      );
      // untracked は difit の target 提示に含まれないため diff.txt に無くても fail にしない
      fakeGit({ untracked: ["src/dropped.ts"] });

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("pass");
    });

    it("target ありでも truncate マーカーは fail（diff.txt は常に SoT）", () => {
      const raw = writeFindingsWith([mustFinding], { must: 1, should: 0, want: 0 });
      writeDifitComments(buildDifitComments(raw));
      fs.appendFileSync(path.join(sessionDir, "diff.txt"), "[... truncated: 5000 lines omitted]\n");
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({
          width: "medium",
          depth: "medium",
          base: "main",
          target: "feature",
          round: 1,
        }),
      );

      const result = stepCheck("normalize_findings")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("truncate マーカー");
    });
  });

  describe("await_human_review（mt-review-diff 単独では常に人間レビューを提示）", () => {
    it("condition を持たない（must>0 でも engine が human gate を提示する）", () => {
      expect(stepOf("await_human_review").condition).toBeUndefined();
    });

    it("check は no-op pass（現行 engine は human_gate の check を実行しない。ゲート通過検証は collect_verdict の dry-run 突合に一本化）", () => {
      expect(stepCheck("await_human_review")(makeCtx()).status).toBe("pass");
    });
  });

  describe("await_human_review humanGate 契約", () => {
    it("presentArtifacts に difit の成果物を含む", () => {
      expect(stepOf("await_human_review").humanGate!.presentArtifacts).toEqual([
        "findings.json",
        "difit-start.json",
        "difit-comments.json",
      ]);
    });

    it("approve desc / question description に difit-start.json の url 提示を明記する", () => {
      const gate = stepOf("await_human_review").humanGate!;
      const question = gate.questions.find((q) => q.key === "decision")!;
      const approve = question.choices!.find((c) => c.value === "approve")!;
      for (const text of [question.description, approve.desc]) {
        expect(text).toContain("difit-start.json");
        expect(text).toContain("url");
        expect(text).toContain("ブラウザ");
      }
    });

    it("approve desc / question description にリビジョンセレクタを起動時の選択へ戻す手順を明記する", () => {
      const gate = stepOf("await_human_review").humanGate!;
      const question = gate.questions.find((q) => q.key === "decision")!;
      const approve = question.choices!.find((c) => c.value === "approve")!;
      for (const text of [question.description, approve.desc]) {
        expect(text).toContain("リビジョンセレクタ");
        expect(text).toContain("起動時の選択");
      }
      expect(question.description).toContain("selection_drift.detection");
      expect(question.description).toContain("detected");
      expect(question.description).toContain("unavailable");
    });
  });

  describe("collect_verdict", () => {
    const verdict = {
      round: 1,
      width: "medium",
      depth: "medium",
      passed: true,
      blocking_threads: [],
    };

    const daemonPass = {
      passes: true,
      blocking_threads: [],
      selection_drift: { detection: "none" },
    };
    const blockingThread = { id: "t1", taxonomy: "issue", body: "🐛 issue real", replies: [] };
    const daemonBlock = {
      passes: false,
      blocking_threads: [blockingThread],
      selection_drift: { detection: "none" },
    };

    it("check --dry-run（非破壊）と verdict が一致する pass で done 後始末と永続化を行う", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // 後始末後の pid 終了確認を通すため、生存しない pid を使う
      writeDifitState(2147483647);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("daemon verified");
      expect(doneCalled()).toBe(true);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(false);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted).toEqual(daemonPass);
    });

    it("done が passes=false を返しても後始末が完了していれば fail（ゲート変化を報告し、後始末失敗と誤診しない）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // 後始末後の pid 終了確認を通すため、生存しない pid を使う
      writeDifitState(2147483647);
      const addedHuman = {
        id: "t9",
        taxonomy: "human",
        file: "src/a.ts",
        line: 9,
        body: "追加の人間コメント",
        replies: [],
      };
      fakeMtDifitGate({
        gateJson: JSON.stringify(daemonPass),
        doneJson: JSON.stringify({ passes: false, blocking_threads: [addedHuman] }),
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("非通過");
      expect(result.reasons.join("\n")).toContain("追加の人間コメント");
      // 後始末は完了しており state は削除されている
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(false);
      expect(doneCalled()).toBe(true);
      // 追加された blocking_threads は executor の feedback として永続化される
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted).toEqual({ passes: false, blocking_threads: [addedHuman] });
    });

    it("done 後に difit プロセスが生存していれば error（orphan 検出）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // state は削除されるが pid は生存している（kill スキップ）状況を模す
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("生存");
      expect(result.reasons.join("\n")).toContain(String(process.pid));
      expect(doneCalled()).toBe(true);
    });

    it("done 後も state ファイルが残っていれば error（後始末未完の検出）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({
        gateJson: JSON.stringify(daemonPass),
        doneRemoveState: false,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain(".difit/difit-review.json");
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
    });

    it("done 後の state が読み取り不能なら error（削除済みと断定して false pass しない）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // 後始末後の pid 終了確認を通すため、生存しない pid を使う
      writeDifitState(2147483647);
      fakeMtDifitGate({
        gateJson: JSON.stringify(daemonPass),
        doneMkdirState: true,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("読み取れません");
    });

    it("block 一致では done を呼ばず state を保持して永続化する（次ラウンドで再利用）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      const blockedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [blockingThread],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(blockedVerdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonBlock), gateExit: 1 });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(blockedVerdict) },
        }),
      );

      expect(result.status).toBe("pass");
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted).toEqual(daemonBlock);
    });

    it("daemon が block なのに verdict が pass なら done を呼ばず state を保持して fail（無破壊・復旧可能）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonBlock), gateExit: 1 });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
      // 復旧は保持済みセッションの再読（pinned threads）で行える
      expect(result.reasons.join("\n")).toContain("mt difit threads --json");
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
      // 不一致でも daemon 出力を永続化し、executor のフィードバックを最新に保つ
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted).toEqual(daemonBlock);
    });

    it("blocking_threads を改変した verdict は不一致 fail（done 未実行で無破壊）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      const tampered = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [{ ...blockingThread, body: "🐛 issue rewritten" }],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(tampered));
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonBlock), gateExit: 1 });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(tampered) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
      expect(doneCalled()).toBe(false);
    });

    it("check --dry-run がゲート出力を返さない（セッション不在）場合は無音 pass せず fail", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitCheckNoOutput();

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("ゲート出力");
      expect(doneCalled()).toBe(false);
    });

    it("セッション不在 fail の復旧案内は effort.json の target を反映する（base 単独起動を案内しない）", () => {
      fakeGit();
      writeEffort({ target: "feature" });
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // target ありの期待選択（base=bbbbbbb, target=aaaaaaa）に一致させる
      writeDifitState(process.pid, 4966, {
        base: "bbbbbbb",
        target: "aaaaaaa",
        baseMode: "merge-base",
      });
      fakeMtDifitCheckNoOutput();

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain(
        'mt difit start "feature" "origin/main" --merge-base',
      );
      expect(result.reasons.join("\n")).not.toContain("mt difit start <base-branch>");
    });

    it("通常経路の difit コマンドエラー（spawn 失敗）は error で終端する（人間判断の fail へ倒さない）", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      const originalPath = process.env.PATH;
      process.env.PATH = binDir; // mt を PATH から外す（git fake のみ残す）
      try {
        const result = stepCheck("collect_verdict")(
          makeCtx({
            attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
          }),
        );

        expect(result.status).toBe("error");
        expect(result.reasons.join("\n")).toContain("spawn 失敗");
        expect(doneCalled()).toBe(false);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("round limit 経路の difit コマンドエラーは error にせず、検証不能を明示して human_gate 判断へ委ねる", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3 });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid);
      const originalPath = process.env.PATH;
      process.env.PATH = binDir; // mt を PATH から外す（git fake のみ残す）
      try {
        const result = stepCheck("collect_verdict")(
          makeCtx({
            attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
          }),
        );

        expect(result.status).toBe("fail");
        const reasons = result.reasons.join("\n");
        expect(reasons).toContain("round limit reached (3/3)");
        expect(reasons).toContain("検証できていません");
        expect(reasons).toContain("human_gate");
        // コマンドエラーのメッセージ（原因）も理由に残す
        expect(reasons).toContain("spawn 失敗");
        expect(doneCalled()).toBe(false);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("round 4 は limit exceeded で fail（mt-review-diff 単独では fail 終端）。dry-run 突合結果を理由と difit-check.json に反映する", () => {
      const round4 = { ...verdict, round: 4 };
      fakeGit();
      writeEffort({ round: 4 });
      writeFindings(4);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round4));
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round4) },
        }),
      );

      // ADR-0026: 単独実行では round limit は fail で終端する（fail/error の併記をやめる）
      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit exceeded");
      expect(reasons).toContain("round=4");
      expect(reasons).toContain("human_gate");
      // 上限経路でも non-destructive な dry-run で daemon 突合を行い、結果を理由に載せる
      expect(reasons).toContain("daemon 突合 ok");
      expect(reasons).toContain("passes=true");
      // 単独実行には後始末ステップが無いため、保持したセッションの手動後始末を案内する
      expect(reasons).toContain("mt difit done");
      expect(doneCalled()).toBe(false);
      // 突合結果は difit-check.json に永続化され、ゲートの提示情報として読める
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      ) as { passes: boolean };
      expect(persisted.passes).toBe(true);
    });

    it("round limit でも daemon と verdict が不一致なら理由に明示する（無検証の終端を可視化）", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3 });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid);
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
        }),
      );

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit reached (3/3)");
      expect(reasons).toContain("不一致");
      expect(reasons).toContain("daemon passes=true");
      expect(reasons).toContain("verdict passed=false");
    });

    it("round limit で dry-run が出力を返さない場合は「検証できていない」ことを理由に明示する", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3 });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid);
      fakeMtDifitCheckNoOutput();

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
        }),
      );

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit reached (3/3)");
      expect(reasons).toContain("検証できていません");
      expect(reasons).toContain("human_gate");
    });

    it("round limit で選択ドリフト中なら pass/blocking 一致でも「突合 ok」と言い切らない", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3 });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid);
      fakeMtDifitGate({
        gateJson: JSON.stringify({
          passes: false,
          blocking_threads: [blockingThread],
          selection_drift: {
            detection: "detected",
            expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
            current: { base: "3333333", target: "4444444" },
          },
        }),
        gateExit: 1,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
        }),
      );

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit");
      expect(reasons).toContain("リビジョンセレクタ");
      expect(reasons).not.toContain("daemon 突合 ok");
      expect(reasons).toContain("信頼性は限定的");
    });

    it("round 3 かつ未通過も fail で終端し、保持したセッションの手動 done を案内する", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3 });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid);
      // verdict と同じ blocking_threads を返す daemon（突合 ok）
      fakeMtDifitGate({
        gateJson: JSON.stringify({ passes: false, blocking_threads: [blockingThread] }),
        gateExit: 1,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
        }),
      );

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit reached (3/3)");
      expect(reasons).toContain("daemon 突合 ok");
      expect(reasons).toContain("mt difit done");
      expect(doneCalled()).toBe(false);
    });

    it("verdict の round が findings と不一致なら fail（古い round による上限判定の無音無効化を防ぐ）", () => {
      const staleRound = { ...verdict, round: 2 };
      writeFindings(); // findings round=1
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(staleRound));

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(staleRound) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("findings.json の round=1");
      expect(doneCalled()).toBe(false);
    });

    it("start 通過後に state.selection を書き換えた TOCTOU はゲート時に検出し、done しない", () => {
      // effort は target あり（期待 selection: base=bbbbbbb target=aaaaaaa）。
      // start 検証の通過後に state.selection を base 単独（target="."）へ書き換え、
      // 空セッションの passes=true をゲートへ読ませる攻撃を、ゲート時再照合で fail にする。
      fakeGit();
      writeEffort({ target: "feature" });
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid); // selection は target="."（effort の target と不一致）
      fakeMtDifitGate({ gateJson: JSON.stringify(daemonPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("一致しません");
      expect(result.reasons.join("\n")).toContain("mt difit start");
      // 通過・後始末を認めない（dry-run も後始末も実行しない）
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "difit-check.json"))).toBe(false);
    });

    it("round limit 経路でも state.selection の再照合を行い、不一致なら突合 ok と扱わない", () => {
      const round3 = { ...verdict, round: 3, passed: false, blocking_threads: [blockingThread] };
      fakeGit();
      writeEffort({ round: 3, target: "feature" });
      writeFindings(3);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round3));
      writeDifitState(process.pid); // selection は target="."（effort の target と不一致）
      fakeMtDifitGate({
        gateJson: JSON.stringify({ passes: false, blocking_threads: [blockingThread] }),
        gateExit: 1,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round3) },
        }),
      );

      expect(result.status).toBe("fail");
      const reasons = result.reasons.join("\n");
      expect(reasons).toContain("round limit reached (3/3)");
      expect(reasons).toContain("再検証に失敗");
      expect(reasons).toContain("一致しません");
      expect(reasons).not.toContain("daemon 突合 ok");
      expect(reasons).toContain("信頼性は限定的");
      expect(doneCalled()).toBe(false);
    });

    it("round limit 経路でも findings との round 不一致を素通りさせない", () => {
      const round4 = { ...verdict, round: 4 };
      writeFindings(); // findings round=1
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round4));

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round4) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("findings.json の round=1");
      expect(result.reasons.join("\n")).not.toContain("daemon 突合 ok");
      expect(doneCalled()).toBe(false);
    });

    it("round limit 経路でも must>0×passed 矛盾を検出する", () => {
      const round4Pass = { ...verdict, round: 4, passed: true };
      writeFindings(4, 1);
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(round4Pass));

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(round4Pass) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("must=1");
      expect(result.reasons.join("\n")).not.toContain("daemon 突合 ok");
      expect(doneCalled()).toBe(false);
    });

    it("check --dry-run の selection_drift 欠落（契約違反）は done せず fail-closed にする", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({
        gateJson: JSON.stringify({ passes: true, blocking_threads: [] }),
        injectDrift: false,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("契約違反");
      expect(result.reasons.join("\n")).toContain("selection_drift");
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
    });

    it("check --dry-run の selection_drift の未知値（旧形式）も done せず fail-closed にする", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({
        gateJson: JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: { detected: true },
        }),
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("解釈できません");
      expect(doneCalled()).toBe(false);
    });

    it("check --dry-run の selection_drift.detection=detected なら verdict 一致でも done せず、起動時の選択へ戻す復旧手順を返す", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      const driftedPass = {
        passes: true,
        blocking_threads: [],
        selection_drift: {
          detection: "detected",
          expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
          current: { base: "3333333", target: "4444444" },
        },
      };
      fakeMtDifitGate({ gateJson: JSON.stringify(driftedPass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("リビジョンセレクタ");
      expect(result.reasons.join("\n")).toContain("起動時の選択");
      expect(result.reasons.join("\n")).toContain("resolve / reply");
      // drift は done の後始末を認めない（セッションを保持して復旧可能にする）
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
      // executor フィードバック用に drift 込みの daemon 出力を永続化する
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted.selection_drift).toEqual(driftedPass.selection_drift);
    });

    it("check --dry-run の selection_drift.detection=unavailable（probe 失敗）は fail-closed で done せず fail する", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      const unavailablePass = {
        passes: true,
        blocking_threads: [],
        selection_drift: {
          detection: "unavailable",
          expected: { base: "1111111", target: "2222222" },
          current: null,
        },
      };
      fakeMtDifitGate({ gateJson: JSON.stringify(unavailablePass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("検知不能");
      expect(result.reasons.join("\n")).toContain("probe 失敗");
      expect(result.reasons.join("\n")).toContain("mt difit start");
      expect(doneCalled()).toBe(false);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(true);
    });

    it("check --dry-run の selection_drift.detection=none は通常どおり done 後始末する", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(2147483647);
      const nonePass = {
        passes: true,
        blocking_threads: [],
        selection_drift: {
          detection: "none",
          expected: { base: "1111111", target: "2222222" },
          current: { base: "1111111", target: "2222222" },
        },
      };
      fakeMtDifitGate({ gateJson: JSON.stringify(nonePass) });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("pass");
      expect(doneCalled()).toBe(true);
      // 永続化した daemon 出力も新スキーマのまま保持する
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "difit-check.json"), "utf-8"),
      );
      expect(persisted.selection_drift).toEqual(nonePass.selection_drift);
    });

    it("check --dry-run の stderr（同一性照合エラー等）を失敗理由に伝搬する", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(process.pid);
      fakeMtDifitGate({
        gateJson: JSON.stringify(daemonBlock),
        gateExit: 1,
        gateStderr: "mt difit: 記録された pid が記録 port を LISTEN していません",
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt difit stderr:");
      expect(result.reasons.join("\n")).toContain("LISTEN していません");
      expect(doneCalled()).toBe(false);
    });

    it("done の stderr を後始末判定の理由に伝搬する", () => {
      fakeGit();
      writeEffort();
      writeFindings();
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      writeDifitState(2147483647);
      fakeMtDifitGate({
        gateJson: JSON.stringify(daemonPass),
        doneStderr: "mt difit done: state ファイルの削除に失敗しました",
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      // 後始末は成功しているため pass。stderr は理由に残す（握りつぶさない）
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain(
        "mt difit stderr: mt difit done: state ファイルの削除に失敗しました",
      );
    });
  });
});

/**
 * collect_context の収集コマンド（prompt の bash ブロック）を実 Git リポジトリで実行し、
 * diff.txt のファイル集合が「difit の提示範囲」と一致することを固定する契約テスト。
 *
 * - target あり: `git diff base...target`（= `mt difit start <target> <base> --merge-base` の
 *   提示範囲）と同じファイル集合になり、untracked は混入しない
 * - target なし: working diff + untracked を収集する（difit の base 単独起動の提示範囲と一致）
 */
describe("collect_context (提示範囲 base...target とのファイル集合一致)", () => {
  let tmp: string;
  let repo: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-review-diff-target-"));
    repo = path.join(tmp, "repo");
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(repo);
    fs.mkdirSync(sessionDir);
    git("init", "-b", "main");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
    }
    return res.stdout ?? "";
  }

  function commitFile(file: string, content: string, message: string): void {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
    git("add", file);
    git("commit", "-m", message);
  }

  /// base(main) に committed 変更を持つ feature ブランチと、working tree の untracked を作る。
  function setupRepo(): void {
    commitFile("src/base.ts", "export const base = 1;\n", "add base");
    commitFile("docs/日本語.md", "初期行\n", "add docs");
    git("checkout", "-b", "feature");
    commitFile("src/feature.ts", "export const feature = 1;\n", "add feature");
    commitFile("docs/日本語.md", "初期行\n追記行\n", "update docs");
    fs.writeFileSync(path.join(repo, "src", "untracked.ts"), "export const untracked = 1;\n");
  }

  /// committed / staged / unstaged / untracked を混在させた feature ブランチを作る
  /// （base=main では merge-base が初期コミットになり、committed 変更が収集範囲に含まれる）。
  /// staged 変更は index に載った tracked ファイルの変更と staged 新規ファイルの両方を作る。
  function setupMixedRepo(): void {
    commitFile("src/base.ts", "export const base = 1;\n", "add base");
    git("checkout", "-b", "feature");
    commitFile("src/committed-only.ts", "export const committedOnly = 1;\n", "add committed");
    commitFile("src/staged-mod.ts", 'export const stagedMod = "v1";\n', "add staged-mod");
    commitFile("src/unstaged-mod.ts", 'export const unstagedMod = "v1";\n', "add unstaged-mod");
    // staged 変更（tracked）+ staged 新規ファイル
    fs.writeFileSync(path.join(repo, "src", "staged-mod.ts"), 'export const stagedMod = "v2";\n');
    git("add", "src/staged-mod.ts");
    fs.writeFileSync(path.join(repo, "src", "staged-new.ts"), "export const stagedNew = 1;\n");
    git("add", "src/staged-new.ts");
    // unstaged 変更 + untracked
    fs.writeFileSync(
      path.join(repo, "src", "unstaged-mod.ts"),
      'export const unstagedMod = "v2";\n',
    );
    fs.writeFileSync(path.join(repo, "src", "untracked.ts"), "export const untracked = 1;\n");
  }

  /// prompt の bash ブロック（収集コマンド）をそのまま実行する。
  function runCollectionCommand(): void {
    const step = stepOf("collect_context");
    const prompt = (step.task as unknown as { buildPrompt: (ctx: unknown) => string }).buildPrompt({
      sessionDir,
      artifacts: [],
    });
    const match = prompt.match(/```bash\n([\s\S]*?)```/);
    expect(match).not.toBeNull();
    const res = spawnSync("bash", ["-c", match![1]], { cwd: repo, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`collection command failed: ${res.stderr ?? ""}`);
    }
  }

  function writeEffort(overrides: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(sessionDir, "effort.json"),
      JSON.stringify({
        width: "medium",
        depth: "medium",
        base: "main",
        round: 1,
        ...overrides,
      }),
    );
  }

  it("target あり: diff.txt のファイル集合が git diff main...feature と一致し、untracked を含まない", () => {
    setupRepo();
    writeEffort({ target: "feature" });

    runCollectionCommand();

    const diffRaw = fs.readFileSync(path.join(sessionDir, "diff.txt"), "utf-8");
    const collected = [...parseDiffChangedLines(diffRaw).keys()].sort();
    const presented = git(
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "main...feature",
    )
      .split("\0")
      .filter((file) => file.length > 0)
      .sort();

    // 提示範囲（base...target）のファイル集合と diff.txt が一致する
    expect(collected).toEqual(presented);
    expect(presented).toContain("docs/日本語.md");
    expect(presented).toContain("src/feature.ts");
    // untracked は difit の target 提示に表示されないため diff.txt に混入しない
    expect(diffRaw).not.toContain("src/untracked.ts");

    // 収集と同一の解決の numstat とファイル別追加/削除行数が一致する
    const stat = listDiffNumstat({ base: "main", target: "feature" }, repo);
    expect("entries" in stat).toBe(true);
    expect(diffNumstatReasons(diffRaw, "entries" in stat ? stat.entries : [])).toEqual([]);
  });

  it("target なし: diff.txt が working diff + untracked を含む（difit の base 単独提示と一致）", () => {
    setupRepo();
    // base 単独起動は HEAD（main）の working diff を提示する。target なし経路の収集対象。
    git("checkout", "main");
    fs.writeFileSync(path.join(repo, "src", "base.ts"), "export const base = 2;\n");
    writeEffort({});

    runCollectionCommand();

    const diffRaw = fs.readFileSync(path.join(sessionDir, "diff.txt"), "utf-8");
    const collected = [...parseDiffChangedLines(diffRaw).keys()].sort();
    expect(collected).toContain("src/base.ts");
    expect(collected).toContain("src/untracked.ts");
  });

  it("target なし: staged 変更と staged 新規ファイルが diff.txt に含まれ、numstat / staged 突合が一致する", () => {
    setupMixedRepo();
    writeEffort({});

    runCollectionCommand();

    const diffRaw = fs.readFileSync(path.join(sessionDir, "diff.txt"), "utf-8");
    // committed + staged + unstaged の全要素が 1 つの収集コマンドに含まれる
    expect(diffRaw).toContain("src/committed-only.ts");
    expect(diffRaw).toContain("src/staged-new.ts");
    expect(diffRaw).toContain('+export const stagedMod = "v2";');
    expect(diffRaw).toContain('+export const unstagedMod = "v2";');

    // 収集と同一の解決の numstat と突合する（staged の index エントリを含む）
    const stat = listDiffNumstat({ base: "main" }, repo);
    expect("entries" in stat).toBe(true);
    const entries = "entries" in stat ? stat.entries : [];
    expect(entries.map((entry) => entry.path)).toContain("src/staged-new.ts");
    expect(diffNumstatReasons(diffRaw, entries)).toEqual([]);

    // staged 突合: index の全エントリ（staged 新規ファイル・staged 変更）が diff.txt に現れる
    const staged = listStagedFiles(repo);
    expect("files" in staged).toBe(true);
    const stagedFiles = "files" in staged ? staged.files : [];
    expect(stagedFiles).toContain("src/staged-new.ts");
    expect(stagedFiles).toContain("src/staged-mod.ts");
    expect(missingStagedFilesReasons(diffRaw, stagedFiles)).toEqual([]);
  });

  it("target なし: マーカーなしの部分出力（head 打ち切り）を numstat / staged 突合が fail にする", () => {
    setupMixedRepo();
    writeEffort({});

    runCollectionCommand();

    const diffRaw = fs.readFileSync(path.join(sessionDir, "diff.txt"), "utf-8");
    // git diff の出力順（パス順）で先頭 5 行 = src/base.ts のブロックのみを残し、
    // 後続の staged エントリを丸ごと落とした状態を再現する
    const truncated = diffRaw.split("\n").slice(0, 5).join("\n");

    const stat = listDiffNumstat({ base: "main" }, repo);
    const entries = "entries" in stat ? stat.entries : [];
    expect(entries.length).toBeGreaterThan(0);
    expect(diffNumstatReasons(truncated, entries).length).toBeGreaterThan(0);

    const staged = listStagedFiles(repo);
    const stagedFiles = "files" in staged ? staged.files : [];
    expect(missingStagedFilesReasons(truncated, stagedFiles).join("\n")).toContain(
      "src/staged-new.ts",
    );
  });
});
