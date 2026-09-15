import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  ArtifactRecord,
  GateAnswers,
  ConditionCtx,
} from "tado";
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { isPathInside } from "tado/artifacts";
import { loadConfig } from "../_shared/mt-plan-init-config";
import { findArtifactText, isRecord } from "../_shared/mt-review-helpers.ts";
import { requireStepArtifacts } from "../_shared/artifact-check";
import { verifyIssueOpen, fetchIssueBody } from "../_shared/gh-issue-verify";

interface RepoInfo {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

function readRepoInfo(artifacts: ArtifactRecord[], sessionDir: string): RepoInfo {
  const raw = findArtifactText(artifacts, REPO_INFO_KEY, sessionDir);
  if (!raw) throw new Error(`Artifact not found: ${REPO_INFO_KEY}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${REPO_INFO_KEY} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${REPO_INFO_KEY} must be a JSON object with owner/repo/nameWithOwner`);
  }
  const { owner, repo, nameWithOwner } = parsed;
  if (
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof repo !== "string" ||
    repo.length === 0 ||
    typeof nameWithOwner !== "string" ||
    nameWithOwner.length === 0
  ) {
    throw new Error(`${REPO_INFO_KEY} must contain non-empty string owner/repo/nameWithOwner`);
  }
  const validName = /^[\w.-]+$/;
  if (!validName.test(owner) || !validName.test(repo)) {
    throw new Error(`${REPO_INFO_KEY}: owner/repo が不正です: "${nameWithOwner}"`);
  }
  if (nameWithOwner !== `${owner}/${repo}`) {
    throw new Error(
      `${REPO_INFO_KEY}: nameWithOwner "${nameWithOwner}" が owner/repo と一致しません`,
    );
  }
  return { owner, repo, nameWithOwner };
}

function isTMiura024(artifacts: ArtifactRecord[], sessionDir: string): boolean {
  return readRepoInfo(artifacts, sessionDir).owner === "t-miura-024";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREPARE_DECISION_KEY = "prepare-decision.json";
const ISSUE_BODY_KEY = "issue-body.md";
const REVIEW_BODY_KEY = "review-body.md";
const GRILL_MAP_KEY = "grill-map.md";
const REPO_INFO_KEY = "repo-info.json";
const ISSUE_NUMBER_KEY = "issue-number.txt";
const EFFORT_PATTERN =
  /<!--\s*effort:\s*width=(low|medium|high|xhigh|max)\s+depth=(low|medium|high|xhigh|max)\s*-->/;
// review-body.md 内の must 残存マーカー。全角英数・全角スペース・漢数字を半角正規化後に判定する。
// 🚨 の存在（直後に なし/無し/ナシ/ゼロ/0 が続く否定文を除く）は全文を対象に残存とみなす。
// `must` と 1 以上の数値の組み合わせは概要セクション（## レビュー結果〜## 指摘一覧の手前）のみを
// 判定対象とする。本文中の通常英文・コード片の must+数字を残存扱いにしないため。
// （`must 0` / `指摘なし` は残存とみなさない）。
// 件数申告の正規形（概要の must n / should n / want n）は厳密パースして数値>0でfailにする。
const MUST_RESIDUAL_PATTERNS = [/🚨/, /\bm\s*u\s*s\s*t\W*[1-9]/i];

function normalizeMustText(text: string): string {
  const halfWidth = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  const halfSpace = halfWidth.replace(/　/g, " ");
  return halfSpace.replace(/[一二三四五六七八九〇零十]/g, (c) => {
    switch (c) {
      case "一":
        return "1";
      case "二":
        return "2";
      case "三":
        return "3";
      case "四":
        return "4";
      case "五":
        return "5";
      case "六":
        return "6";
      case "七":
        return "7";
      case "八":
        return "8";
      case "九":
        return "9";
      case "〇":
      case "零":
        return "0";
      case "十":
        return "10";
      default:
        return c;
    }
  });
}

// 件数申告の正規形から must 件数を厳密パースする（見つからなければ null）。
function parseDeclaredMustCount(normalized: string): number | null {
  const m = normalized.match(/\bm\s*u\s*s\s*t\W*([0-9]+)/i);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

// 概要セクション（## レビュー結果〜## 指摘一覧の手前）を切り出す。
// 見出しが見つからなければ全文を返す（fail-closed）。
function extractSummarySection(text: string): string {
  const start = text.indexOf("## レビュー結果");
  if (start === -1) return text;
  const end = text.indexOf("## 指摘一覧", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

// must 残存の二重照合: 概要セクションの厳密パース（数値>0でfail）と
// 概要セクション内の must+数値パターンのいずれかで残存とみなす。
// 🚨 は全文を対象に、否定直後（なし/無し/ナシ/ゼロ/0）を除いて残存とみなす。
function hasMustResidual(text: string): boolean {
  const normalizedSummary = normalizeMustText(extractSummarySection(text));
  const declared = parseDeclaredMustCount(normalizedSummary);
  if (declared !== null && declared > 0) return true;
  const normalizedFull = normalizeMustText(text);
  const withoutNegatedEmoji = normalizedFull.replace(/🚨\s*(なし|無し|ナシ|ゼロ|0)\s*/g, "");
  if (MUST_RESIDUAL_PATTERNS[0].test(withoutNegatedEmoji)) return true;
  if (MUST_RESIDUAL_PATTERNS[1].test(normalizedSummary)) return true;
  return false;
}

// 分解モードで子 body が存在するのに review-body.md が子に言及しない場合は
// 子未レビューとみなして fail に倒す（未レビュー子の refined 化を防ぐ機械ゲート）。
// prepare-decision.json の有無に依存せず、子ファイルの実在で判定する。
// 子レビュー痕跡の対応検証: 子ファイル名への単なる言及ではなく、子ごとの
// 指摘セクション見出し（例: ### 対象: issue-body-1.md）または対象表行
// （例: | 対象 | issue-body-1.md |）での言及を要求する。
// 「対象外」一文のような除外記載だけでは子レビューとみなさない。
function hasChildTargetMention(reviewBody: string, child: string): boolean {
  const escaped = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^###.*対象.*${escaped}`);
  return reviewBody.split("\n").some((line) => {
    if (!line.includes(child)) return false;
    if (line.includes("対象外")) return false;
    if (headingPattern.test(line)) return true;
    if (line.includes("|") && line.includes("対象")) return true;
    return false;
  });
}

export function requireChildReviewIfChildrenExist(ctx: CheckCtx): CheckResult {
  let children: string[];
  try {
    children = readdirSync(ctx.sessionDir).filter((f) => /^issue-body-\d+\.md$/.test(f));
  } catch {
    return { status: "fail", reasons: ["子body列挙に失敗したため検証不能"] };
  }
  if (children.length === 0) return { status: "pass", reasons: [] };
  // symlink 差し替えによる任意ファイル流出を防ぐ: 子 body は実ファイルのみ許容し、
  // 解決後パスが sessionDir 配下であることを確認する（fail-closed）。
  for (const child of children) {
    const fullPath = resolve(join(ctx.sessionDir, child));
    try {
      if (lstatSync(fullPath).isSymbolicLink()) {
        return {
          status: "fail",
          reasons: [`${child}: symlink のため検証不能（子 body は実ファイルであること）`],
        };
      }
    } catch {
      return { status: "fail", reasons: ["子body列挙に失敗したため検証不能"] };
    }
    if (!isPathInside(ctx.sessionDir, fullPath)) {
      return { status: "fail", reasons: [`${child}: sessionDir 配下にないため検証不能`] };
    }
  }
  const reviewBody = findArtifactText(ctx.artifacts, REVIEW_BODY_KEY, ctx.sessionDir) ?? "";
  const missing = children.filter((child) => !hasChildTargetMention(reviewBody, child));
  if (missing.length > 0) {
    return {
      status: "fail",
      reasons: [
        `${REVIEW_BODY_KEY}: 子 body（${children.join(", ")}）が存在するのに子レビューの痕跡がない（子ごとに「対象」見出し（例: ### 対象: issue-body-<n>.md）または対象表行での言及が必要。不足: ${missing.join(", ")}）`,
      ],
    };
  }
  return { status: "pass", reasons: [] };
}
const mtGrillRoundsDir = join(import.meta.dir, "..", "mt-grill-rounds");
const mtDomainModelingDir = join(import.meta.dir, "..", "mt-domain-modeling");

// ---------------------------------------------------------------------------
// Loop (human gate revise 置換) ヘルパー
// ---------------------------------------------------------------------------
//
// human_gate の revise 撤去に伴い、差し戻し→再作業→再提示は loop の continue
// 巻き戻しで再現する。構成: loop 本体 [作業ステップ群＋ゲート＋judge 末尾]。
// judge（loop 末尾 check）が ctx.gateAnswers の当該ゲート decision を読み、
// approve→pass / request_changes→continue / abort→error / 未知・未回答→fail。
// request_changes の追加入力は loop 先頭 worker の prompt へ注入する
// （検証は軽量版: body 非空＋source 対応＝自ゲートの outcome 回答のみ読む）。
// 上限到達時は continue を返さない（onExhausted=escalate で停止すると loop 外へ
// 届かないため）。代わりに枯渇マーカーを残して pass で脱出し、loop 外の人間
// 判断ゲート（approve/abort）へ渡す。loop 内ゲートは無条件で毎反復再実行される
// ため skip による stale 回答は発生しない。judge は自ゲートの outcome 回答のみ
// 読み、他ゲートの回答は拾わない（幽霊差し戻し防止）。

const REVIEW_CYCLE_LOOP_KEY = "review_cycle";
const REVIEW_EXHAUSTED_GATE_KEY = "review_exhausted";
const REVIEW_CYCLE_EXHAUSTED_KEY = "review-cycle-exhausted.json";

function gateAnswerValue(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer;
  if (isRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}

function gateDecisionValue(
  gateAnswers: GateAnswers,
  stepKey: string,
  questionKey = "decision",
): string | undefined {
  const perGate = gateAnswers[stepKey];
  if (!perGate) return undefined;
  return gateAnswerValue(perGate[questionKey]);
}

function gateDecisionInput(
  gateAnswers: GateAnswers,
  stepKey: string,
  questionKey = "decision",
): string | undefined {
  const ans = gateAnswers[stepKey]?.[questionKey];
  if (typeof ans !== "string" && isRecord(ans) && typeof ans.input === "string") {
    return ans.input;
  }
  return undefined;
}

function decideGateRework(
  value: string | undefined,
): "pass" | "continue" | "abort" | "unknown" | "missing" {
  if (value === undefined) return "missing";
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "abort";
  return "unknown";
}

const REVIEW_GATE_KEY = "review_gate";
const REVIEW_CYCLE_MAX_ITERATIONS = 3;

// 枯渇マーカーの厳密検証。返値は valid マーカーか absent のみ。
// ファイル不在（ENOENT）のみ absent（null）として返す。読み取り失敗・
// JSON 破損・形状不一致（loop/gate/iteration のいずれか不一致）は throw し、
// 呼び出し元の condition ではエンジンエラー（fail-closed）、check では
// fail/error に倒す。fail-open の false 返しはしない。
// iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
// engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
// workflow の judge は iteration >= maxIterations で先回りして pass 抜けする。
// overshoot（iteration > max）でも valid として fail-closed にする。
function readExhaustedMarker(
  sessionDir: string,
  markerKey: string,
): { loop: string; gate: string; iteration: number } | null {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, markerKey), "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new Error(
      `枯渇マーカーの読み取りに失敗しました (${markerKey}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `枯渇マーカーが破損しています (${markerKey}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`枯渇マーカーの検証に失敗しました (${markerKey}): JSON オブジェクトが必要です`);
  }
  if (parsed.loop !== REVIEW_CYCLE_LOOP_KEY) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): loop の一致が必要です（期待 ${REVIEW_CYCLE_LOOP_KEY}）`,
    );
  }
  if (parsed.gate !== REVIEW_GATE_KEY) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): gate の一致が必要です（期待 ${REVIEW_GATE_KEY}）`,
    );
  }
  const iterationValue = parsed.iteration;
  if (
    typeof iterationValue !== "number" ||
    !Number.isInteger(iterationValue) ||
    iterationValue < REVIEW_CYCLE_MAX_ITERATIONS
  ) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): iteration は ${REVIEW_CYCLE_MAX_ITERATIONS} 以上の整数が必要です`,
    );
  }
  return { loop: REVIEW_CYCLE_LOOP_KEY, gate: REVIEW_GATE_KEY, iteration: iterationValue };
}

function isLoopExhausted(sessionDir: string, markerKey: string, loopKey: string): boolean {
  const marker = readExhaustedMarker(sessionDir, markerKey);
  if (marker === null) return false;
  return marker.loop === loopKey;
}

// loop 先頭 worker の prompt へ注入する差し戻し文面。初回実行（未回答・approve・
// 入力空）は「なし」行を返す。捏造の "(追加入力なし)" は作らない（欠落は judge が fail で止める）。
function reworkFeedbackSection(gateAnswers: GateAnswers, gateKey: string): string[] {
  const value = gateDecisionValue(gateAnswers, gateKey);
  const input = gateDecisionInput(gateAnswers, gateKey);
  if (value === "request_changes" && input !== undefined && input.trim() !== "") {
    return [
      "## 前回の差し戻し（loop 再実行時はこの指摘を反映する）",
      "",
      `- ${gateKey}: ${input.trim()}`,
      "",
    ];
  }
  return ["## 前回の差し戻し", "", "- (なし。初回実行)", ""];
}

function judgeGateRework(
  ctx: CheckCtx,
  opts: {
    gateKey: string;
    loopKey: string;
    headKey: string;
    markerKey: string;
    exhaustedKey: string;
  },
): CheckResult {
  // 配置・世代ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
  if (ctx.loop?.key !== opts.loopKey) {
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} の判定は ${opts.loopKey} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
      ],
    };
  }
  const decision = decideGateRework(gateDecisionValue(ctx.gateAnswers, opts.gateKey));
  if (decision === "missing") {
    return {
      status: "fail",
      reasons: [`${opts.gateKey} が実行されましたが gateAnswers に回答がありません`],
    };
  }
  if (decision === "pass") {
    // 正常 pass 時の後始末: stale な枯渇マーカーが残っていれば削除し、
    // 後段の review_exhausted condition の誤発火を防ぐ。不在は正常。
    try {
      unlinkSync(join(ctx.sessionDir, opts.markerKey));
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        return {
          status: "error",
          reasons: [
            `枯渇マーカーの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    }
    return { status: "pass", reasons: [`${opts.gateKey} approved — proceed`] };
  }
  if (decision === "abort") {
    return {
      status: "error",
      reasons: [
        `${opts.gateKey} で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません`,
      ],
    };
  }
  if (decision === "unknown") {
    const value = gateDecisionValue(ctx.gateAnswers, opts.gateKey);
    return {
      status: "fail",
      reasons: [
        `${opts.gateKey} の回答値が想定外です: ${value}（approve / request_changes / abort のいずれか）`,
      ],
    };
  }
  const input = gateDecisionInput(ctx.gateAnswers, opts.gateKey);
  if (input === undefined || input.trim() === "") {
    return {
      status: "fail",
      reasons: [
        `${opts.gateKey} の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする`,
      ],
    };
  }
  if (ctx.loop.iteration >= ctx.loop.maxIterations) {
    // 最終反復で continue を返すと onExhausted=escalate で停止し loop 外ゲートへ届かない。
    // 枯渇マーカーを残して pass で脱出し、loop 外の人間判断ゲートへ渡す。
    try {
      writeFileSync(
        join(ctx.sessionDir, opts.markerKey),
        `${JSON.stringify({ loop: opts.loopKey, gate: opts.gateKey, iteration: ctx.loop.iteration })}\n`,
        "utf-8",
      );
    } catch (error) {
      return {
        status: "error",
        reasons: [
          `枯渇マーカーの永続化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    return {
      status: "pass",
      reasons: [
        `${opts.gateKey} request_changes (iteration ${ctx.loop.iteration}/${ctx.loop.maxIterations} で上限到達) — ${opts.exhaustedKey} で人間が判断します`,
      ],
    };
  }
  return {
    status: "continue",
    reasons: [`${opts.gateKey} request_changes — rewind ${opts.loopKey} to ${opts.headKey}`],
  };
}

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

const def: WorkflowDef = {
  id: "mt-plan-create",
  description:
    "GitHub Issueとして計画を新規作成・リファインメントするワークフロー。from-Issue取り込みとGrillヒアリングを経て本文レビューを行い、承認後にRefined Issueを直接作成する。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
  },

  afterInit: async (ctx: InitCtx) => {
    let stdout: string;
    try {
      stdout = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
        encoding: "utf-8",
      }).trim();
    } catch (error) {
      throw new Error(
        `gh repo view failed: ${error instanceof Error ? error.message : String(error)}. gh auth login と git リポジトリを確認してください。`,
      );
    }
    if (!stdout || !stdout.includes("/")) {
      throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
    }
    const parts = stdout.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
    }
    const [owner, repo] = parts;
    const validName = /^[\w.-]+$/;
    if (!validName.test(owner) || !validName.test(repo)) {
      throw new Error(`repo名が不正です: "${stdout}"`);
    }
    const repoInfo: RepoInfo = { owner, repo, nameWithOwner: stdout };
    const repoInfoPath = join(ctx.sessionDir, REPO_INFO_KEY);
    writeFileSync(repoInfoPath, JSON.stringify(repoInfo, null, 2), "utf-8");
    return { artifacts: [{ key: REPO_INFO_KEY, path: repoInfoPath }] };
  },

  steps: [
    // -----------------------------------------------------------------
    // Loop: レビューサイクル（human gate revise 置換）
    //   差し戻し→再作業→再提示は loop の continue 巻き戻しで再現する。
    //   本体 = 作業ステップ群（grill 先頭）＋ review_gate ＋ judge_review 末尾。
    //   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
    //   マーカーを残して pass で脱出し、loop 外の review_exhausted へ渡す。
    //   対応エンジン: tado#24（type: "loop" / 判定 continue / onExhausted /
    //   gateAnswers 注入）以降。loop 外で check が continue を返すとエンジンが
    //   fail-fast するため、loop 外ステップの check は continue を返さない。
    // -----------------------------------------------------------------
    {
      key: "review_cycle",
      phase: "レビューサイクル",
      type: "loop",
      maxIterations: 3,
      onExhausted: "escalate",
      body: [
        // -----------------------------------------------------------------
        // Step 1: Grill Phase
        // -----------------------------------------------------------------
        {
          key: "grill",
          phase: "Grill Phase",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);
              const grillMapPath = join(ctx.sessionDir, GRILL_MAP_KEY);

              const hearingSection = withDocs
                ? [
                    "### 2. 徹底ヒアリング + ドメインモデリング",
                    "",
                    `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                    "",
                    `加えて mt-domain-modeling スキル（${join(mtDomainModelingDir, "SKILL.md")}）を参照し、その規律をすべて適用する。`,
                    "",
                    "**重要:** repo へのファイル書き込み（CONTEXT.md の更新、ADR ファイルの作成）は禁止。",
                    "確定した用語・ADR 案はすべてライブ地図の `## 確定用語` / `## ADR 案` セクションに記録すること。",
                    `フォーマットは ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} / ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従う。`,
                  ]
                : [
                    "### 2. 徹底ヒアリング",
                    "",
                    `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                  ];

              return [
                "## 目的",
                "",
                "計画の全側面についてユーザーと共通認識に達するまでヒアリングを行う（Grill Phase）。",
                "",
                ...reworkFeedbackSection(ctx.gateAnswers, "review_gate"),
                "## 手順",
                "",
                "### 1. from-Issue フローの確認",
                "",
                "ユーザーに「既存 Issue を取り込みますか？」と確認する。",
                "- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う",
                "- No の場合: 新規計画としてヒアリングを開始する",
                "",
                ...hearingSection,
                "",
                "ヒアリングは mt-grill-rounds の方式に従って進める:",
                `- ライブ地図のパスは既定パスではなく \`${grillMapPath}\`（セッションディレクトリ配下）を明示的に指定し、このパスで地図を育成する`,
                "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
                "- 回答をライブ地図へ反映した後にフロンティアを再計算し、次のラウンドを提示する",
                "- フロンティアが空になり、ユーザーが共通認識を確認するまでラウンドを継続する",
                "",
                "### 3. ライブ地図の最終確認",
                "",
                `ヒアリングの全決定がセッションディレクトリのライブ地図 \`${grillMapPath}\` に蒸留されていることを確認する。`,
                "地図は Markdown 入れ子リスト＋状態マーカー（`[確定]` / `[未決]` / `[保留]`）の単一ファイルとし、質疑ログなどの別ファイルは残さない。",
                ...(withDocs
                  ? [
                      "ドメインモデリングで確定した用語・ADR 案が `## 確定用語` / `## ADR 案` セクションに記録されていることも確認する。",
                    ]
                  : []),
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `{"key": "${GRILL_MAP_KEY}", "path": "${grillMapPath}"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          // 統一最低ライン: ライブ地図の申告・実在・非空を強制する。
          // 地図の構造（見出し・セクション）は mt-grill-rounds が適応的に決めるため固定しない。
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [{ key: GRILL_MAP_KEY, form: "markdown" }]);
          },
        },

        // -----------------------------------------------------------------
        // Step 2: 本文マッピング
        // -----------------------------------------------------------------
        {
          key: "draft_body",
          phase: "本文マッピング",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);

              return [
                "## 目的",
                "",
                "ヒアリングで集まった情報を plan-format.md のテンプレートにマッピングし、Issue body の最終本文を確定する。",
                "分解モードの場合は子 Issue の body もすべてこのステップで生成する。",
                "",
                "## 手順",
                "",
                "### 1. ヒアリング結果の読み込み",
                "",
                `セッションディレクトリの \`${GRILL_MAP_KEY}\`（ライブ地図）を読み込む。`,
                "from-Issue フローの場合は既存 Issue の内容も合わせて参照する。",
                "",
                ...(withDocs
                  ? [
                      "### 2. ドキュメントの整形・埋め込み",
                      "",
                      `Grill Phase で \`${GRILL_MAP_KEY}\` の \`## 確定用語\` / \`## ADR 案\` セクションに記録された確定用語・ADR 案は確定済みとして扱う。要否の再判断はしない。`,
                      "",
                      "以下を行い、plan-format.md の `## 📄 ドキュメント` セクションに埋め込む:",
                      `- CONTEXT は ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} に従い本文を整形する`,
                      `- ADR は ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従い本文を整形する`,
                      "- ADR 連番は対象 repo の `docs/adr/` を確認して次番号を確定する",
                      "- セクション形式: `### <リポジトリ相対パス>` + コードフェンス全文",
                      "",
                    ]
                  : []),
                "",
                `### ${withDocs ? "3" : "2"}. 縦切り分解の検討`,
                "",
                "大きな計画を実行可能なミッションへ割る場合は、次を守る:",
                "- 各ミッションは 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする",
                "- 単独で確認できる振る舞いを持つ",
                "- 依存関係は実行順の Wave 配置で表現する（plan-format.md の `### 実行順` 参照）",
                "",
                `### ${withDocs ? "4" : "3"}. 最終本文の確定`,
                "",
                `plan-format.md（${join(import.meta.dir, "..", "_shared", "mt-plan-plan-format.md")}）に従い、Issue body の最終本文を確定する。`,
                `確定した本文をセッションディレクトリに \`${ISSUE_BODY_KEY}\` として書き出す。`,
                "Issue body の末尾には検証強度の推奨を `<!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->` 形式の HTML コメントとして必ず追記する（例: `<!-- effort: width=medium depth=medium -->`）。値は計画の複雑さ・影響範囲から推奨を選び、このコメントを検証強度の決定値の初期値とする（review_gate に width/depth 質問は置かない。変更はファイル直接編集で行う）。既存 Issue（本変更以前に作成されたものでコメントが無いもの）では mt-plan-run の parseEffortFromIssueBody がコメント未検出時に width=medium depth=medium へフォールバックする（既存 Issue 対応）。",
                '生成直後に `grep -E "<!-- effort: width=(low|medium|high|xhigh|max) depth=(low|medium|high|xhigh|max) -->" issue-body.md` で検証し、不一致・欠落があればコメントを追記/修正して再生成する。値は /^[a-z]+$/ の enum のみを許容し、不正値があれば medium に正規化する。',
                "mt-plan-run はこのコメントを parseEffortFromIssueBody で読み取り effort.json 生成に利用するため、コメントの形式は厳守する。",
                "",
                "分解モードの場合:",
                "- 親 Issue の body を `issue-body.md` として書き出す",
                "- 各子計画の body を `issue-body-<n>.md`（n = 1, 2, 3...）として書き出す",
                "- ドキュメントセクション（`## 📄 ドキュメント`）は対応する子計画の body に配置し、親には残さない",
                "- 子計画は 1 階層までとし、再分解しない",
                "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすこと",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `{"key": "${ISSUE_BODY_KEY}", "path": "${join(ctx.sessionDir, ISSUE_BODY_KEY)}"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [
              {
                key: ISSUE_BODY_KEY,
                form: "markdown",
                sections: ["## ✅ 完了条件", "## 🧭 方針"],
                patterns: [EFFORT_PATTERN],
              },
            ]);
          },
        },

        // -----------------------------------------------------------------
        // Step 3: 本文レビュー
        // -----------------------------------------------------------------
        {
          key: "review_body",
          phase: "本文レビュー",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              // NOTE: owner 分岐（withDocs）は grill / draft_body / review_body の3箇所に分散する。
              // _shared への抽出は最小差分方針のため見送る（条件変更時は3箇所を同時更新すること）。
              const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);

              const perspectiveC = withDocs
                ? [
                    "### C: 思想・ポリシー違反＋ADR記載明記",
                    "",
                    "プロジェクト思想・ポリシー（mt-domain-modeling の規律）への違反がないか確認する。",
                    "確定した用語・ADR 案が plan-format.md の `## 📄 ドキュメント` セクションに `### <リポジトリ相対パス>` + コードフェンス全文の形式で明記されているか確認する。",
                    "",
                  ]
                : [
                    "### C: 思想・ポリシー違反＋ADR記載明記（本 repo ではスキップ）",
                    "",
                    "owner が t-miura-024 の場合のみ適用する観点のため、本 repo ではレビュー対象外とする。",
                    "",
                  ];

              return [
                "## 目的",
                "",
                "draft_body で確定した Issue body を 6 観点で自己レビューし、指摘を重み付けして review-body.md に記録する。",
                "SubAgent は使わず、このステップのエージェント自身がレビューする。起草者自身のレビューのため盲点が残り得るが、grill-map 確定事項との突合という機械的照合を中心とし、残存リスクは後段の review_gate で人間が must/should の有無を見て approve/request_changes を選ぶことで回収する。review_gate では人間が判断材料の件数だけでなく review-body.md 全文と grill-map 確定事項に対する body の反映差分を直接確認してから approve/request_changes を選ぶこと。body の修正は行わず、指摘の記録に専念する。must/should が残る場合は review_gate で人間が request_changes を選び grill に戻って再生成する（approve は must/should がゼロの場合のみ）。記録専用であるため軽微な指摘でも request_changes→grill→draft→review の全再生成という往復コストが発生するが、SubAgent 新設なし・差分最小の方針のため許容する。",
                "",
                "## 手順",
                "",
                "### 1. 入力の読み込み",
                "",
                `セッションディレクトリの \`${GRILL_MAP_KEY}\`（ライブ地図）と \`${ISSUE_BODY_KEY}\`（親 body）を読み込む。`,
                "分解モード（子 body `issue-body-<n>.md` が存在する場合）は `ls issue-body-*.md` で全件検出してすべて読み込み、全件を必須レビュー対象とする。子への指摘は `対象` 欄に `issue-body-<n>.md` を明記する。通常モード（子 body が存在しない場合）のレビュー対象は親 body のみとする。",
                `判定基準として plan-format.md（${join(import.meta.dir, "..", "_shared", "mt-plan-plan-format.md")}）を参照する。`,
                "",
                "### 2. 6観点レビュー",
                "",
                "以下の 6 観点で本文をレビューする:",
                "",
                "### A: 追加すり合わせ候補",
                "",
                "Grill で聞き漏らした曖昧さ・未決事項がないか洗い出す。背景・完了条件・方針の各記述が検証可能な粒度になっているか確認する。",
                "",
                "### B: 決定間矛盾",
                "",
                "完了条件・方針・アウトプット・ミッション間の矛盾がないか確認する。ミッションのスコープと完了条件番号の対応に漏れ・重複がないか確認する。",
                "",
                ...perspectiveC,
                "### D: grill-map反映完全性",
                "",
                `ライブ地図（\`${GRILL_MAP_KEY}\`）の \`[確定]\` 事項が body に過不足なく反映されているか確認する。`,
                "from-Issue フローの場合は既存 Issue 内容の取り込み漏れも確認する。",
                "",
                "### E: plan-format準拠性",
                "",
                "必須セクションの有無、ミッション定義（スコープ重複なし・完了条件カバー）、effort コメントの形式（`<!-- effort: width=... depth=... -->`）、Issue title と body の役割分担（body に `# 計画タイトル` を含めない）を確認する。",
                "",
                "### F: 実行可能性・検証可能性",
                "",
                "完了条件が Yes/No で判定可能な状態として書かれているか確認する。分解する場合は各ミッションが縦に貫く tracer bullet になっており、Wave 配置が依存順になっているか確認する。",
                "",
                "### 3. 指摘の重み付け",
                "",
                "各指摘を create 用の判定基準で must/should/want に重み付けする（ラベル定義は mt-plan-run と一致）:",
                "",
                "- 🚨 must: 完了条件の充足を阻害する欠陥。ニーズ充足の漏れ、実行不能を招く決定間矛盾、必須セクション・effort コメントの欠落、grill-map 確定事項の反映漏れなど。review_gate の decision で人間が対応可否を判断する（must が残る場合は request_changes を選び grill に戻る。approve は選択不可）。",
                "- ⚠️ should: 実行は可能だが品質・明確性を著しく損なう問題。完了条件の検証可能性が低い表現、スコープ境界の曖昧さ、ミッション分割の不備の疑いなど。review_gate の decision で人間が対応可否を判断する（should が残る場合も request_changes 推奨。approve は人間が対応不要と判断した場合のみ）。",
                "- 💡 want: 対応任意の改善提案・軽微な追加すり合わせ候補。review_gate をブロックしない（approve 可）。",
                "",
                "### 4. レビュー結果の書き出し",
                "",
                `レビュー結果を ${ctx.sessionDir}/${REVIEW_BODY_KEY} に書き出す。形式:`,
                "",
                "```markdown",
                "## レビュー結果",
                "",
                "概要（指摘件数: must n / should n / want n、総合判断）を書く。",
                "",
                "## 指摘一覧",
                "",
                "### 1. <指摘タイトル>",
                "",
                "| 項目 | 内容 |",
                "|------|------|",
                "| 優先度 | 🚨 must |",
                "| 観点 | A: 追加すり合わせ候補 |",
                "| 対象 | issue-body-1.md の§X |",
                "",
                "<指摘内容の詳細。理由と対応案を書く。>",
                "```",
                "",
                "指摘が 0 件の場合は `## 指摘一覧` に `指摘なし` と明記する。",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `{"key": "${REVIEW_BODY_KEY}", "path": "${join(ctx.sessionDir, REVIEW_BODY_KEY)}"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            // 前提成果物の存在も要求する（欠落時の捏造レビューを fail に倒す）。
            // 分解モードの子レビューは子ファイル実在ベースで要求する（子未レビューのまま refined 化させない）。
            const result = requireStepArtifacts(ctx, [
              { key: GRILL_MAP_KEY, form: "markdown" },
              { key: ISSUE_BODY_KEY, form: "markdown" },
              {
                key: REVIEW_BODY_KEY,
                form: "markdown",
                sections: ["## レビュー結果", "## 指摘一覧"],
                patterns: [/(🚨 must|⚠️ should|💡 want|指摘なし)/],
              },
            ]);
            if (result.status !== "pass") return result;
            return requireChildReviewIfChildrenExist(ctx);
          },
        },

        // -----------------------------------------------------------------
        // Step 4: 起票準備
        // -----------------------------------------------------------------
        {
          key: "prepare",
          phase: "起票準備",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              const repoInfo = readRepoInfo(ctx.artifacts, ctx.sessionDir);

              return [
                "## 目的",
                "",
                "起票に必要な環境整備（label 確認）を行い、分解要否の判定材料を artifact に書き出す。",
                "",
                "## 手順",
                "",
                "### 1. 対象 repo の確認",
                "",
                `対象 repo: \`${repoInfo.nameWithOwner}\`（afterInit で取得済み）`,
                "",
                "- owner が `t-miura-024` → そのまま",
                "- それ以外 → `t-miura-024/note` + `external/<repo>` label",
                "",
                "### 2. label の確認・自動作成",
                "",
                "`kind/plan` label がなければ自動作成。`external/<repo>` label も同様（冪等に）。",
                "",
                "```bash",
                'gh label list --search "kind/plan" --json name',
                'gh label create "kind/plan" --description "計画 Issue" --color "0075ca" 2>/dev/null || true',
                "```",
                "",
                "### 3. 分解要否の判定",
                "",
                `Grill Phase で確定した内容（ライブ地図 \`${GRILL_MAP_KEY}\`）を確認し、以下を判定する:`,
                "",
                '- 計画が複数の機能・領域を含み、単一 Issue では独立した完了条件と進捗を管理できない場合 → `mode: "decompose"`',
                '- それ以外 → `mode: "update"`',
                "",
                "from-Issue フローの場合は既存 Issue 番号も記録する。",
                "",
                "### 4. 判定結果の書き出し",
                "",
                `判定結果を ${ctx.sessionDir}/prepare-decision.json に書き出す:`,
                "",
                "```json",
                "{",
                '  "mode": "update" | "decompose",',
                '  "fromIssue": true | false,',
                '  "issueNumber": <number | null>,',
                '  "repo": "<owner>/<repo>"',
                "}",
                "```",
                "",
                "### 5. 起票案の提示",
                "",
                "分解する場合は、親・子の計画案（各子の目的・対応スコープ）を提示する準備をする。",
                "- 子計画は 1 階層までとし、再分解しない",
                "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすことを確認する",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `{"key": "prepare-decision.json", "path": "${ctx.sessionDir}/prepare-decision.json"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [
              {
                key: PREPARE_DECISION_KEY,
                form: "json",
                keys: ["mode", "fromIssue", "issueNumber", "repo"],
              },
            ]);
          },
        },

        // -----------------------------------------------------------------
        // Step 5: レビューゲート
        // -----------------------------------------------------------------
        // NOTE: 旧 create_draft ステップは create_refined に改名済み。旧キー・旧 artifact
        // （issue-number.txt 提示）を参照する実行中セッションは resume せず abort し、
        // 新規セッションで開始すること（破壊的変更の移行策）。
        // abort 時は Issue 未作成のため残留 Draft は発生しない（from-Issue でも既存 Issue への変更前に終わるため残留物なし）。
        {
          key: "review_gate",
          phase: "レビュー",
          type: "human_gate",
          maxRetries: 1,
          onFail: { action: "abort" },
          humanGate: {
            // Issue 実物ではなく session ファイル（issue-body.md / review-body.md / prepare-decision.json）を対象にレビューする。
            // 承認後に create_refined が refined で直接作成するため、gate 時点では Issue は存在しない。
            // NOTE: 分解モードの子 body（issue-body-<n>.md）は件数が動的なため presentArtifacts に列挙できない。
            // 子の品質担保は review-body.md の子レビュー痕跡（check で機械検証）と create_refined の子未レビュー時 escalate ガード（fail→escalate）で行う。
            // width/depth 質問は置かない（draft_body が書き出す effort コメント初期値に一本化。死に質問化の再発防止）。
            presentArtifacts: ["issue-body.md", "review-body.md", "prepare-decision.json"],
            outcomeQuestionKey: "decision",
            questions: [
              {
                key: "decision",
                title: "判定",
                type: "choice_with_input",
                choices: [
                  {
                    value: "approve",
                    label: "refined で作成する",
                    desc: "内容が完成・実行可能。review-body.md に must が残る場合は選択不可（request_changes を選ぶこと）。should 残存時の approve は人間が対応不要と判断した場合のみ",
                    input: { required: false, maxLength: 500 },
                  },
                  {
                    value: "request_changes",
                    label: "修正する",
                    desc: "Grill Phase に戻って内容を再検討する（loop が grill 先頭へ巻き戻る。Issue は未作成のため残留物なし）。review-body.md に must/should が残る場合はこちらを選ぶ",
                    input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
                  },
                  { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
                ],
              },
            ],
          },
          // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
          // （mt-plan-run / mt-review-diff と同一）。must 残存時の approve 抑止は上記 decision
          // の choice desc（人間の判断）に委ね、create_refined 到達時の must 残存は escalate で fail-closed にする。
          check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
        },

        // -----------------------------------------------------------------
        // Step 5b: 差し戻し判定（loop 末尾）
        //   review_gate の gateAnswers を読んで分岐する loop の check。
        //   request_changes → 判定 `continue` で loop 先頭（grill）へ巻き戻る。
        //   上限到達時は枯渇マーカーを残して pass で脱出し、loop 外の
        //   review_exhausted へ渡す。ゲート skip 時は発生しない（loop 内ゲートは
        //   無条件のため毎反復実行される）。4分岐に pass フォールバックは設けない。
        // -----------------------------------------------------------------
        {
          key: "judge_review",
          phase: "差し戻し判定",
          type: "task",
          maxRetries: 0,
          onFail: { action: "abort" },
          task: {
            action: "orchestrate",
            // NOTE: agent への指示は report のみだが、check が上限到達時に枯渇マーカーの
            // 永続化という副作用を持つため readonly:true の宣言は実態と合わない。外す。
            readonly: false,
            buildPrompt: (ctx: PromptCtx) =>
              [
                "## 目的",
                "",
                "review_gate の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
                "",
                "## 指示",
                "",
                "- agent は report のみ行い、ファイルの作成・編集を実行しない（agent の作業は read-only）",
                "- 分岐判定と枯渇マーカーの永続化は check が決定論的に行う。分岐判定が check に委ねられていることを報告する",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n"),
          },
          check: (ctx: CheckCtx): CheckResult =>
            judgeGateRework(ctx, {
              gateKey: "review_gate",
              loopKey: REVIEW_CYCLE_LOOP_KEY,
              headKey: "grill",
              markerKey: REVIEW_CYCLE_EXHAUSTED_KEY,
              exhaustedKey: REVIEW_EXHAUSTED_GATE_KEY,
            }),
        },
      ],
    },

    // -----------------------------------------------------------------
    // Step 5c: 上限到達時の人間判断（loop 外）
    //   judge が枯渇マーカーを残した反復でのみ condition が true になり提示する。
    //   正常 pass 時は提示しない。選択肢は approve/abort のみとし、
    //   request_changes は持たせない（loop 外で continue を返すとエンジンが
    //   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
    // -----------------------------------------------------------------
    {
      key: "review_exhausted",
      phase: "上限到達判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: (ctx: ConditionCtx): boolean =>
        isLoopExhausted(ctx.sessionDir, REVIEW_CYCLE_EXHAUSTED_KEY, REVIEW_CYCLE_LOOP_KEY),
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: ["issue-body.md", "review-body.md", "prepare-decision.json"],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "レビューサイクルが上限（3 反復）に達しても差し戻しが解消しませんでした。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。差し戻し内容が未反映のまま作成へ進むか、中断するかを選択してください。承認時は must 残存があっても create_refined の check が警告として記録し作成へ進む",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "差し戻しを残したまま作成へ進む",
                desc: "未反映の指摘を残したまま create_refined へ進む（must 残存は警告として記録される）",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
            ],
          },
        ],
      },
    },

    // -----------------------------------------------------------------
    // Step 6: Refined Issue 作成
    // -----------------------------------------------------------------
    {
      key: "create_refined",
      phase: "Refined Issue 作成",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "review_gate で承認された Issue body を使って Refined Issue を直接作成（または更新）する。",
            "コンテンツ生成は行わず、effort コメント確定と GitHub 操作のみに専念する。",
            "承認前の作成はしない（本ステップは review_gate 通過後のみ実行される）。",
            "",
            "## 手順",
            "",
            "### 1. 入力情報の読み込み",
            "",
            `セッションディレクトリの \`${ISSUE_BODY_KEY}\` と \`${PREPARE_DECISION_KEY}\` と \`${REVIEW_BODY_KEY}\` を読み込む。`,
            "分解モードの場合は `issue-body-<n>.md` も `ls issue-body-*.md` で全件検出して読み込む。分解モードで子 body が存在するのに review-body.md に子への言及（`issue-body-<n>.md` の記載）がない場合は子未レビューのため GitHub 操作へ進まず escalate する（未レビュー子の refined 化を禁止。GitHub 操作を停止し失敗報告のみ行うこと）。",
            "prepare-decision.json から mode / fromIssue / issueNumber / repo を確認する。",
            "review-body.md の 🚨 must 有無を確認する。must が残るまま本ステップに到達した場合は判断漏れのため GitHub 操作へ進まず escalate する（create_refined の check が must 残存で fail し onFail escalate となる。tado 上で review_gate の request_changes を選び grill に戻って再生成すること）。ただし review-cycle-exhausted.json の valid マーカーがある枯渇経由（review_exhausted の approve）の場合は警告として記録し作成へ進む（check が警告付きで後続へ進む）。body の再生成はしない（修正は request_changes→grill 経由の再生成に一本化）。",
            "",
            "### 2. effort コメントの確定",
            "",
            "各ファイル末尾の `<!-- effort: width=... depth=... -->` コメント（draft_body が書き出した初期値を決定値とする）を維持し、形式検証のみ行う。各ファイルで既存 `<!-- effort:.*?-->` を `/<!-- effort:.*?-->/` で置換せず、そのまま残す。コメントが欠落している場合のみ末尾に追記する（冪等）。分解モードでは `ls issue-body-*.md 2>/dev/null` で全件検出し各ファイルで同様に確認する。新規作成フローでは Issue 作成前のため `gh issue edit` は不要だが、from-Issue フロー・リトライ更新パスでは後段 §3 の `gh issue edit` で effort 反映済み body を更新すること。",
            'このコメントは mt-plan-run の parseEffortFromIssueBody が読み取るため形式は厳守する。更新後は `grep -E "<!-- effort: width=(low|medium|high|xhigh|max) depth=(low|medium|high|xhigh|max) -->" issue-body.md`（分解モードでは `issue-body-*.md` の各件も対象にして）で検証する。不一致・欠落があればコメントを修正して再検証するループを繰り返し、それでも一致しなければ escalate して GitHub 作成へ進まない（失敗報告し、作成コマンドを実行しない）。',
            "",
            "### 3. Refined Issue の作成または更新",
            "",
            `セッションディレクトリに issue-number.txt が存在する場合（リトライ時）は、既存 Issue を \`gh issue edit\` で更新し、新規作成はしない（冪等ガード）。`,
            "存在しない場合は新規作成する。",
            "分解モードで子 Issue の作成まで進んで失敗した場合は、作成済みの子は再作成せず既存番号を使い、未作成の子のみ作成する。部分失敗時の再実行は issue-number.txt を起点に本ステップから再開する（finalize から再開しない）。",
            "",
            '**番号検証（必須）:** `gh issue edit` / `mt-plan-transition-plan.ts` に渡す番号は、必ずセッションディレクトリ内の `issue-number.txt` と `issue-number-<n>.txt` の全件から読み取った値のみ使う。LLM が記憶・推測した番号を直接埋め込まない。使う前に全件の数字形式を検証し（例: `for f in ${ctx.sessionDir}/issue-number.txt ${ctx.sessionDir}/issue-number-*.txt; do [ -f "$f" ] || continue; grep -Eq \'^[0-9]+$\' "$f" || echo "NG: $f"; done`）、1件でも不一致・空・欠落があれば GitHub 操作へ進まず escalate する。シェルに渡すパスはセッションディレクトリ配下の絶対パスで指定し、クォートする。',
            "",
            "#### 3a. from-Issue フロー（既存 Issue を更新）",
            "",
            "```bash",
            `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
            "```",
            "",
            "**重要:** 新規作成せず、必ず既存 Issue を更新すること。",
            "",
            "#### 3b. 新規作成フロー（mode: update）",
            "",
            "```bash",
            `gh issue create --title "<title>" --body-file ${ctx.sessionDir}/issue-body.md --label "kind/plan"`,
            "```",
            "",
            "#### 3c. 分解モード（mode: decompose）",
            "",
            "親 Issue を作成（または from-Issue の場合は更新）した後、各子計画について Issue を作成する（親子すべて `kind/plan` label。旧文言の draft 要素は意図的に廃止し `kind/plan` のみ付与する仕様）:",
            "",
            "```bash",
            `gh issue create --title "<子タイトル>" --body-file ${ctx.sessionDir}/issue-body-<n>.md --label "kind/plan"`,
            "```",
            "",
            "GitHub REST API で親子関係を設定する:",
            "",
            "```bash",
            "gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \\",
            "  -f sub_issue_id=<child-issue-id>",
            "```",
            "",
            "### 4. Project への追加と refined 化",
            "",
            "Issue（分解モードの場合は親子すべて）を GitHub Project に追加する:",
            "",
            "```bash",
            "gh project item-add <project-number> --owner <owner> --url <issue-url>",
            "```",
            "",
            "続けて refined に遷移する（Status 更新 + `## 🐢 履歴` へ遷移エントリ追記）。`<number>` には §3 の番号検証を通過した `issue-number.txt` と `issue-number-<n>.txt` の全件の値のみ使う（未検証の番号を渡さない）:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "..", "_shared", "mt-plan-transition-plan.ts")} <number> refined`,
            "```",
            "",
            "分解モードの場合は子 Issue すべてと親 Issue について実行し、親子すべてを refined にする。",
            "",
            "### 5. Issue 番号の記録",
            "",
            "§3 で Issue を1件作成するごとに直ちに `issue-number.txt`（子は `issue-number-<n>.txt`）へ記録し、§4 に進む前に全件の記録を完了する（作成と記録の間隔を空けず、再実行時の重複作成を防ぐ）。",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        // review-body.md を必須化する（未申告・欠落時は GitHub 照合の前に fail）。
        // must 残存時の approve 抑止は review_gate が human_gate のため機械化できず、
        // 人間が誤って approve した場合の最終防壁としてここで must 否定検査を行う（fail-closed）。
        // ただし枯渇経由（review-cycle-exhausted.json の valid マーカーあり＋
        // review_exhausted の approve）の場合はゲートの約束どおり未反映のまま
        // 作成へ進むため、must 残存は fail ではなく警告として記録し後続へ進む。
        const result = requireStepArtifacts(ctx, [
          { key: ISSUE_NUMBER_KEY, form: "text", pattern: /^[0-9]+$/ },
          {
            key: REVIEW_BODY_KEY,
            form: "markdown",
            sections: ["## レビュー結果", "## 指摘一覧"],
            patterns: [/(🚨 must|⚠️ should|💡 want|指摘なし)/],
          },
        ]);
        if (result.status !== "pass") return result;
        let exhausted = false;
        try {
          exhausted = isLoopExhausted(
            ctx.sessionDir,
            REVIEW_CYCLE_EXHAUSTED_KEY,
            REVIEW_CYCLE_LOOP_KEY,
          );
        } catch (error) {
          return {
            status: "error",
            reasons: [
              `枯渇マーカーの検証に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
            ],
          };
        }
        const reviewBody = findArtifactText(ctx.artifacts, REVIEW_BODY_KEY, ctx.sessionDir) ?? "";
        let exhaustedWarning: string | null = null;
        if (hasMustResidual(reviewBody)) {
          if (exhausted) {
            exhaustedWarning = `${REVIEW_BODY_KEY}: must が残存しているが、枯渇経由の承認（${REVIEW_EXHAUSTED_GATE_KEY} approve）のため警告として記録し作成へ進む`;
          } else {
            return {
              status: "fail",
              reasons: [
                `${REVIEW_BODY_KEY}: must が残存している（approve 不可。request_changes で grill に戻ること）`,
              ],
            };
          }
        }
        // 分解モードの子未レビューを GitHub 照合の前に fail に倒す。
        // 子未レビューは枯渇経由でも免除しない（構造欠落のため）。
        const childResult = requireChildReviewIfChildrenExist(ctx);
        if (childResult.status !== "pass") return childResult;
        // 副作用実照合: 起票・更新した Issue が GitHub 上に OPEN で存在するか
        const raw = findArtifactText(ctx.artifacts, ISSUE_NUMBER_KEY, ctx.sessionDir);
        const number = (raw ?? "").trim();
        const ghReasons = verifyIssueOpen(number);
        const warningReasons = exhaustedWarning === null ? [] : [exhaustedWarning];
        return ghReasons.length > 0
          ? { status: "fail", reasons: [...warningReasons, ...ghReasons] }
          : {
              status: "pass",
              reasons: [...warningReasons, `issue #${number} is open on GitHub`],
            };
      },
    },

    // -----------------------------------------------------------------
    // Step 7: 完了処理（報告のみ）
    // -----------------------------------------------------------------
    {
      key: "finalize",
      phase: "完了処理",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return [
            "## 目的",
            "",
            "作成した Refined Issue の内容を報告する。GitHub への変更は行わない（作成・refined 化は create_refined が完了済み）。",
            "create_refined が Project 追加・refined 遷移で部分失敗した場合は本ステップから再開せず、issue-number.txt を起点に create_refined を再実行してから報告する。",
            "",
            "## 手順",
            "",
            "### 1. Issue 番号の確認",
            "",
            `セッションディレクトリの issue-number.txt から Issue 番号を読み取る。読み取る前に \`grep -Eq '^[0-9]+$'\` で検証し、不正なら GitHub操作へ進まず escalate する（失敗報告のみ）。`,
            "",
            "### 2. 作成内容の報告",
            "",
            "以下を報告する:",
            "- Issue URL・番号",
            "- 対象 repo",
            "- Project・Status（refined であること）",
            "- label",
            "- `mt-plan-run` で実行可能であることを案内",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        const result = requireStepArtifacts(ctx, [
          { key: ISSUE_NUMBER_KEY, form: "text", pattern: /^[0-9]+$/ },
        ]);
        if (result.status !== "pass") return result;
        // 副作用実照合: refined 昇格の痕跡（履歴エントリ + effort コメント）を GitHub 上で確認
        const raw = findArtifactText(ctx.artifacts, ISSUE_NUMBER_KEY, ctx.sessionDir);
        const number = (raw ?? "").trim();
        let body: string;
        try {
          body = fetchIssueBody(number);
        } catch (e) {
          return {
            status: "fail",
            reasons: [`gh: failed to fetch issue #${number} (${String(e)})`],
          };
        }
        const reasons: string[] = [];
        if (!/\[[^\]]*refined[^\]]*\]/.test(body)) {
          reasons.push(`issue #${number}: refined 昇格の履歴エントリが見つからない`);
        }
        if (!EFFORT_PATTERN.test(body)) {
          reasons.push(`issue #${number}: effort コメントが確定していない`);
        }
        return reasons.length > 0
          ? { status: "fail", reasons }
          : { status: "pass", reasons: [`issue #${number} promoted to refined`] };
      },
    },
  ],
};

export default def;
