import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
  InitCtx,
  AfterInitResult,
  ConditionCtx,
  GateAnswers,
} from "tado";
import { buildStepPrompt } from "../_shared/mt-prompt";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  auditPlanner,
  auditResearcher,
  auditWriter,
  auditReviewer,
  auditResearchCycle,
  auditWriterReviewerCycle,
} from "./scripts/audit";
import type { AuditCheck } from "./scripts/audit";
import { requireStepArtifacts } from "../_shared/artifact-check";

const SCRIPTS_DIR = join(import.meta.dir, "scripts");

function openResearchDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function toCheckResult(checks: AuditCheck[]): CheckResult {
  const errored = checks.filter((c) => c.status === "error");
  if (errored.length > 0) {
    return { status: "error", reasons: errored.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    return { status: "fail", reasons: failed.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  return { status: "pass", reasons: checks.map((c) => `${c.check_name}: ${c.detail}`) };
}

const RESEARCH_DB = "research.db";

// ---------------------------------------------------------------------------
// 計画承認サイクル（human gate revise の loop 置換）
//   phase3b_plan_approval の request_changes 差し戻しは、旧 revise 相当として
//   loop の判定 continue で phase3_planner 先頭へ巻き戻る（再作業→再提示）。
//   巻き戻し先は旧 `reviseTargetStep: "phase3_planner"` を本体先頭に据える
//   （`git show HEAD:...` で復元。worktree では revise 撤去済みのため request_changes が後継語彙）。
//   上限（3 反復）到達時は judge が pass で loop を抜け、loop 外の
//   plan_approval_exhausted_gate（approve/abort のみ）で人間が受容・中断を選ぶ。
//   世代管理は GATE_SKIP_CONDITIONS registry（plan-run の condition-registry 方式）
//   で行い、skip ゲートの旧回答を現世代の判定に拾わない。全読み取りは
//   currentGateDecision / currentGateInput に一本化する（幽霊差し戻しを作らない）。
// ---------------------------------------------------------------------------

/// gate 回答の契約外形状に fail-closed な record 判定。
function isGateAnswerRecord(value: unknown): value is { value?: unknown; input?: unknown } {
  return typeof value === "object" && value !== null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnoent(error: unknown): boolean {
  return isObjectRecord(error) && error.code === "ENOENT";
}

/// loop 内 human_gate の decision 回答値の読み取り（純粋関数）。
/// choice_with_input 回答は `{ value, input? }`、single_choice 回答は文字列。
/// 未回答・契約外形状は undefined（呼び出し元の error/fail 経路へ載せる）。
function gateDecisionValue(gateAnswers: GateAnswers, stepKey: string): string | undefined {
  const answer = gateAnswers[stepKey]?.["decision"];
  if (typeof answer === "string") return answer;
  if (isGateAnswerRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}

/// loop 内 human_gate の decision 追加入力の読み取り（純粋関数）。
/// 文字列以外の input は欠落扱い（undefined）とする。
function gateDecisionInput(gateAnswers: GateAnswers, stepKey: string): string | undefined {
  const answer = gateAnswers[stepKey]?.["decision"];
  if (isGateAnswerRecord(answer) && typeof answer.input === "string") return answer.input;
  return undefined;
}

/// gate 回答値の純粋判定（plan-run の decideGateRework 定型）。
/// approve → pass / request_changes → continue / abort → abort /
/// 未回答 missing・未知 unknown に分離（missing → error・unknown → fail）。
/// 旧 revise 値は受理しない（互換シムなし。fail の理由で移行先を案内する）。
/// loop 外の check は continue を返さない（エンジンが fail-fast する）。
function decideGateRework(
  value: string | undefined,
): "pass" | "continue" | "abort" | "unknown" | "missing" {
  if (value === undefined) return "missing";
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "abort";
  return "unknown";
}

const PLAN_APPROVAL_LOOP_KEY = "plan_approval_cycle";
const PLAN_APPROVAL_GATE_KEY = "phase3b_plan_approval";
const PLAN_APPROVAL_EXHAUSTED_KEY = "plan_approval_exhausted_gate";
const PLAN_APPROVAL_EXHAUSTED_MARKER = "plan-approval-exhausted.json";
const PLAN_APPROVAL_MAX_ITERATIONS = 3;

// 枯渇マーカーの厳密検証。request_changes の追加入力（input）を永続化し、
// 下流（枯渇ゲート・後続 step）へ伝達する。返値は valid マーカーか absent のみ。
// ファイル不在（ENOENT）のみ absent（null）。読み取り失敗・JSON 破損・
// 形状不一致（loop/gate/iteration/input のいずれか不一致・欠落）は throw し、
// condition ではエンジンエラー（fail-closed）、check では error/fail に倒す。
// iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
// engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
// workflow の judge は iteration >= maxIterations で先回りして pass 抜けする。
// overshoot（iteration > max）でも valid として fail-closed にする。
function readPlanApprovalExhaustedMarker(
  sessionDir: string,
): { loop: string; gate: string; iteration: number; input: string } | null {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, PLAN_APPROVAL_EXHAUSTED_MARKER), "utf-8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new Error(
      `枯渇マーカーの読み取りに失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `枯渇マーカーが破損しています (${PLAN_APPROVAL_EXHAUSTED_MARKER}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): JSON オブジェクトが必要です`,
    );
  }
  if (parsed.loop !== PLAN_APPROVAL_LOOP_KEY) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): loop の一致が必要です（期待 ${PLAN_APPROVAL_LOOP_KEY}）`,
    );
  }
  if (parsed.gate !== PLAN_APPROVAL_GATE_KEY) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): gate の一致が必要です（期待 ${PLAN_APPROVAL_GATE_KEY}）`,
    );
  }
  const iterationValue = parsed.iteration;
  if (
    typeof iterationValue !== "number" ||
    !Number.isInteger(iterationValue) ||
    iterationValue < PLAN_APPROVAL_MAX_ITERATIONS
  ) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): iteration は ${PLAN_APPROVAL_MAX_ITERATIONS} 以上の整数が必要です`,
    );
  }
  const inputValue = parsed.input;
  if (typeof inputValue !== "string" || inputValue.trim() === "") {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${PLAN_APPROVAL_EXHAUSTED_MARKER}): input（request_changes 追加入力の永続化）が必要です`,
    );
  }
  return {
    loop: PLAN_APPROVAL_LOOP_KEY,
    gate: PLAN_APPROVAL_GATE_KEY,
    iteration: iterationValue,
    input: inputValue,
  };
}

/// loop 枯渇の検出（plan_approval_exhausted_gate の condition 本体）。
/// judge が上限到達時に書き残す枯渇マーカーの有無で判定する（fail-closed）。
/// gateAnswers 最新値のみではクリア時に常時非提示となるため使わない。
/// マーカー不在 → false（正常 pass で非提示）。破損・不一致 → throw（escalate）。
function isPlanApprovalExhausted(ctx: ConditionCtx): boolean {
  const marker = readPlanApprovalExhaustedMarker(ctx.sessionDir);
  if (marker === null) return false;
  return true;
}

// buildPrompt 用の枯渇フィードバック読み取り（fail-safe）。prompt 生成では
// throw せず、欠落・破損時はその旨の1行を返す（判定の fail-closed とは分離）。
function exhaustedFeedbackLine(sessionDir: string): string {
  let marker: { input: string } | null = null;
  try {
    marker = readPlanApprovalExhaustedMarker(sessionDir);
  } catch (error) {
    return `(⚠️ 枯渇マーカーの検証に失敗: ${error instanceof Error ? error.message : String(error)})`;
  }
  if (marker === null) return "- (なし。枯渇なし)";
  return `- ${PLAN_APPROVAL_GATE_KEY}: ${marker.input}`;
}

/// gateAnswers 世代管理の skip 判定 registry（plan-run の GATE_SKIP_CONDITIONS 方式）。
/// condition を持つゲートは step の condition と同一関数を登録する（写像ドリフト防止）。
/// 常時提示の loop 内ゲートは登録不要（常に最新回答が現世代）。
/// テストから参照するため export する（registry 更新強制テスト用）。
export const GATE_SKIP_CONDITIONS: Record<string, (ctx: ConditionCtx) => boolean> = {
  plan_approval_exhausted_gate: isPlanApprovalExhausted,
};

/// 世代を考慮した gate 回答値の読み取り（全読み取りの単一 chokepoint）。
/// skip されたゲートの旧回答は undefined（未回答扱い）として返し、幽霊差し戻しを作らない。
/// skip 判定の分岐を直接テストするため export する。
export function currentGateDecision(
  gateAnswers: GateAnswers,
  ctx: ConditionCtx,
  stepKey: string,
): string | undefined {
  const skipWhen = GATE_SKIP_CONDITIONS[stepKey];
  if (skipWhen && !skipWhen(ctx)) return undefined;
  return gateDecisionValue(gateAnswers, stepKey);
}

/// 世代を考慮した gate 追加入力の読み取り（currentGateDecision と対）。
function currentGateInput(
  gateAnswers: GateAnswers,
  ctx: ConditionCtx,
  stepKey: string,
): string | undefined {
  const skipWhen = GATE_SKIP_CONDITIONS[stepKey];
  if (skipWhen && !skipWhen(ctx)) return undefined;
  return gateDecisionInput(gateAnswers, stepKey);
}

/// loop 先頭 worker への差し戻し注入文面。request_changes の追加入力を原文のまま載せる。
/// 回答なし・approve・abort・未知値は「なし」扱い（abort は judge が error で止める）。
function formatGateReworkFeedback(
  gateAnswers: GateAnswers,
  ctx: ConditionCtx,
  stepKey: string,
): string {
  const value = currentGateDecision(gateAnswers, ctx, stepKey);
  if (value !== "request_changes") return "- (なし。初回実行または前回 approve)";
  const input = currentGateInput(gateAnswers, ctx, stepKey);
  if (input === undefined || input.trim() === "") {
    return `- ${stepKey}: (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、judge の check が fail で停止する)`;
  }
  return `- ${stepKey}: ${input}`;
}

const def: WorkflowDef = {
  id: "mt-deep-research",
  description:
    "ローカルSearXNGとSubAgentオーケストレーションで自律的な多段探索を行うワークフロー。Planner/Researcher/Writer/Reviewer/Auditorが連携し成果物を生成する。",

  beforeInit: async (_ctx: InitCtx) => {
    const checks: string[] = [];

    try {
      const searx =
        await $`curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"`
          .nothrow()
          .quiet();
      if (searx.stdout.toString().trim() !== "200") {
        checks.push("SearXNG is not responding (http://localhost:8080)");
      }
    } catch {
      checks.push("SearXNG check failed");
    }

    try {
      await $`command -v jq`.nothrow().quiet();
    } catch {
      checks.push("jq is not installed");
    }

    try {
      await $`command -v pandoc`.nothrow().quiet();
    } catch {
      checks.push("pandoc is not installed");
    }

    try {
      await $`command -v bun`.nothrow().quiet();
    } catch {
      checks.push("bun is not installed");
    }

    if (!existsSync(join(SCRIPTS_DIR, "node_modules"))) {
      const install = await $`cd ${SCRIPTS_DIR} && bun install`.nothrow().quiet();
      if (install.exitCode !== 0) {
        checks.push(`bun install failed in ${SCRIPTS_DIR}`);
      }
    }

    if (checks.length > 0) {
      throw new Error(`Prerequisites check failed:\n${checks.map((c) => `  - ${c}`).join("\n")}`);
    }
  },

  afterInit: async (ctx: InitCtx): Promise<AfterInitResult> => {
    const dbPath = join(ctx.sessionDir, RESEARCH_DB);
    const result = await $`bun run ${join(SCRIPTS_DIR, "db.ts")} init --db-path ${dbPath}`
      .nothrow()
      .quiet();
    if (result.exitCode !== 0) {
      throw new Error(`DB init failed: ${result.stderr.toString()}`);
    }
    return { artifactDbPath: dbPath };
  },

  steps: [
    // -----------------------------------------------------------------------
    // Phase 1: 事前ヒアリング
    // -----------------------------------------------------------------------
    {
      key: "phase1_hearing",
      phase: "Phase 1: 事前ヒアリング",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const hearingPath = join(ctx.sessionDir, "hearing.md");
          return buildStepPrompt({
            purpose: [
              "事前ヒアリング。調査の背景・目的・前提知識をユーザーから引き出し hearing.md にまとめる。",
            ],
            criteria: [],
            approach: [
              {
                title: "1. ヒアリング本体",
                content: [
                  "質問は一度に 1 つ。ユーザーが「十分」と宣言するまで継続する。",
                  "質問の際は番号付きの 3 つの選択肢を提示し、各選択肢に 5 段階の推奨度（例: ★★★★☆）と理由を添える。",
                  "",
                  "- **ユーザー決定領域:** 背景、目的、前提知識、制約、スコープ — 推測で埋めず質問で確認",
                  "- **AI 提案領域:** 調査方針、観点、制約の提案 — 選択肢・推奨度・理由を添えて提案",
                  "",
                ],
              },
              {
                title: "2. 軽量な調査で済む場合の判断",
                content: [
                  "軽量な一次資料調査だけで足りる場合は、フル Deep Research の前に次を試してよい:",
                  "1. 公式 docs / 仕様 / ソースコードなど一次資料だけを当たる",
                  "2. 主張ごとに出典を付ける",
                  "3. リポジトリの既存メモ規約に合わせて 1 ファイルへ残す",
                  "",
                  "この場合、フル Deep Research を継続するかユーザーに確認する。",
                  "",
                ],
              },
              {
                title: "3. hearing.md の書き出し",
                content: [
                  `ヒアリング結果を ${hearingPath} に書き出す（背景・目的・前提知識・制約・スコープを構造化）。`,
                ],
              },
            ],
            output: [
              "report 時の `artifacts` に以下を含める:",
              "```json",
              `{"key": "hearing.md", "path": "${hearingPath}"}`,
              "```",
            ],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `hearing.md 出力先: ${hearingPath}`,
            ],
          });
        },
      },
      // 統一最低ライン: 申告義務・実在・非空を強制（DB 直書きステップは
      // 既存 SQLite 監査が最低ライン相当。ファイル成果物を持つのは phase1 のみ）
      check: (ctx: CheckCtx): CheckResult => {
        return requireStepArtifacts(ctx, [{ key: "hearing.md", form: "markdown" }]);
      },
    },

    // -------------------------------------------------------------------
    // 計画承認サイクル（human gate revise の loop 置換。旧 revise 相当の巻き戻し先
    // = phase3_planner を本体先頭に据える）
    //   maxIterations は 3、onExhausted は escalate。上限到達時は judge の pass 抜けを
    //   経て loop 外の plan_approval_exhausted_gate（approve/abort のみ）へ渡る。
    //   反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
    //   phase3_planner へ巻き戻る（report の nextAction は repeat）。
    //   loop 外で check が continue を返すとエンジンが fail-fast する。
    // -------------------------------------------------------------------
    {
      key: "plan_approval_cycle",
      phase: "計画承認サイクル",
      type: "loop",
      maxIterations: 3,
      onExhausted: "escalate",
      body: [
        // -----------------------------------------------------------------------
        // Phase 3: 計画立案 (Planner。plan_approval_cycle の先頭)
        //   前反復で phase3b_plan_approval が request_changes を返した場合は、
        //   その追加入力を gateAnswers から注入して再作業する（revise 相当）。
        // -----------------------------------------------------------------------
        {
          key: "phase3_planner",
          phase: "Phase 3: 計画立案",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "run_subagent",
            subagentType: "mt-deep-research-planner",
            readonly: false,
            buildPrompt: (ctx: PromptCtx) => {
              const planPath = join(ctx.sessionDir, "plan.md");
              const planTemplate = join(import.meta.dir, "templates", "plan.md");
              return buildStepPrompt({
                purpose: [
                  "plan.md を作成し、questions テーブルに 3〜7 個（推奨 5 個）の主要な問いを登録する。",
                ],
                criteria: [],
                approach: [
                  {
                    title: "担当範囲",
                    content: [
                      "- plan.md の作成（`templates/plan.md` の構成に従う、mermaid 必須）",
                      "- questions テーブルへの問い登録（`db.ts question create` を使用）",
                      "- hearing.md（事前ヒアリング結果）を読み、背景・目的・前提知識・制約を plan.md に反映する",
                      "",
                    ],
                  },
                  {
                    title: "実行コマンド",
                    content: [
                      "```bash",
                      `bun run ${join(SCRIPTS_DIR, "db.ts")} question create --content "..." --order 1 --db-path ${ctx.artifactDbPath}`,
                      "```",
                    ],
                  },
                ],
                output: [
                  `plan.md を ${planPath} に書き出す。`,
                  "questions テーブルに 3〜7 個の主要な問いを登録する。",
                ],
                policy: [
                  "- ファイルを直接編集しない（plan.md は書き込み可）",
                  "- Human Gate を代行しない",
                  "- 制約・スコープも Planner が提案する",
                ],
                input: [
                  `セッションディレクトリ: ${ctx.sessionDir}`,
                  `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
                  `plan.md 出力先: ${planPath}`,
                  `plan テンプレート: ${planTemplate}`,
                  `hearing.md（事前ヒアリング結果）: ${join(ctx.sessionDir, "hearing.md")}`,
                  `反復: ${ctx.loop?.iteration ?? 1}/${ctx.loop?.maxIterations ?? 3}（上限到達時は loop 外の人間判断へ渡る）`,
                  `前回差し戻し（gate:phase3b_plan_approval。request_changes の追加入力。原文のまま反映する）: ${formatGateReworkFeedback(ctx.gateAnswers, ctx, "phase3b_plan_approval")}`,
                ],
              });
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
            const db = openResearchDb(ctx.artifactDbPath);
            try {
              const planPath = join(ctx.sessionDir, "plan.md");
              const checks = auditPlanner(db, planPath);
              return toCheckResult(checks);
            } finally {
              db.close();
            }
          },
        },

        // -----------------------------------------------------------------------
        // Phase 3b: 計画承認（plan_approval_cycle 本体。human_gate は確認と回答保存のみを
        // 行い、巻き戻しは行わない。差し戻しは judge_plan_approval が gateAnswers を読んで
        // 判定 `continue` で行い、本体先頭の phase3_planner へ巻き戻る）
        // -----------------------------------------------------------------------
        {
          key: "phase3b_plan_approval",
          phase: "Phase 3b: 計画承認",
          type: "human_gate",
          maxRetries: 1,
          onFail: { action: "escalate" },
          humanGate: {
            presentArtifacts: ["plan.md"],
            outcomeQuestionKey: "decision",
            questions: [
              {
                key: "decision",
                title: "判定",
                type: "choice_with_input",
                choices: [
                  {
                    value: "approve",
                    label: "承認",
                    desc: "plan.md の内容で調査を開始する",
                    // NOTE(plan93): secret masking / sanitization is handled at tado engine/dashboard layer (gate_events.answersJson display escaping), not workflow; maxLength 500 is sufficient per plan 93 unified rule scope.
                    input: { required: false, maxLength: 500 },
                  },
                  {
                    value: "request_changes",
                    label: "修正が必要",
                    desc: "judge_plan_approval が gateAnswers を読んで loop 先頭（phase3_planner）へ巻き戻し、入力した修正理由を反映して計画を立て直す",
                    input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
                  },
                  { value: "abort", label: "中断" },
                ],
              },
            ],
          },
          check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
        },

        // -------------------------------------------------------------------
        // 承認差し戻し判定（plan_approval_cycle 末尾）
        //   phase3b_plan_approval の gateAnswers を読んで分岐する loop の check。
        //   approve → pass / request_changes → 判定 `continue` で本体先頭
        //   （phase3_planner）へ巻き戻る / abort → error / 未知・未回答 → fail。
        //   request_changes は追加入力の非空を軽量検証する（body 非空。
        //   source は当該ゲート固定読みで対応）。最終反復の request_changes は
        //   pass で loop を抜け、loop 外の plan_approval_exhausted_gate で人間が
        //   受容・中断を判断する（loop 外の continue はエンジンが fail-fast する）。
        // -------------------------------------------------------------------
        {
          key: "judge_plan_approval",
          phase: "承認差し戻し判定",
          type: "task",
          maxRetries: 0,
          onFail: { action: "abort" },
          task: {
            action: "orchestrate",
            // NOTE: agent への指示は report のみだが、check が上限到達時に枯渇マーカーの
            // 永続化という副作用を持つため readonly:true の宣言は実態と合わない。外す。
            readonly: false,
            buildPrompt: (ctx: PromptCtx) =>
              buildStepPrompt({
                purpose: [
                  "phase3b_plan_approval の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
                ],
                criteria: [],
                approach: [
                  "agent は report のみ行い、ファイルの作成・編集を行わない（read-only）",
                  "分岐判定が check に委ねられていることを報告する",
                ],
                output: ["分岐判定の材料となる報告。"],
                input: [`セッションディレクトリ: ${ctx.sessionDir}`],
              }),
          },
          check: (ctx: CheckCtx): CheckResult => {
            // 配置・世代ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
            if (ctx.loop?.key !== PLAN_APPROVAL_LOOP_KEY) {
              return {
                status: "error",
                reasons: [
                  `${PLAN_APPROVAL_GATE_KEY} の判定は ${PLAN_APPROVAL_LOOP_KEY} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
                ],
              };
            }
            const value = gateDecisionValue(ctx.gateAnswers, PLAN_APPROVAL_GATE_KEY);
            const decision = decideGateRework(value);
            if (decision === "missing") {
              return {
                status: "error",
                reasons: [
                  `${PLAN_APPROVAL_GATE_KEY} が実行されましたが gateAnswers に回答がありません。ゲート未 confirmed のまま判定ステップへ進んでいます`,
                ],
              };
            }
            if (decision === "pass") {
              // 正常 pass 時の後始末: stale な枯渇マーカーが残っていれば削除する。不在は正常。
              try {
                unlinkSync(join(ctx.sessionDir, PLAN_APPROVAL_EXHAUSTED_MARKER));
              } catch (error) {
                if (!isEnoent(error)) {
                  return {
                    status: "error",
                    reasons: [
                      `枯渇マーカーの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
                    ],
                  };
                }
              }
              return { status: "pass", reasons: ["phase3b_plan_approval approved — proceed"] };
            }
            if (decision === "abort") {
              return {
                status: "error",
                reasons: [
                  "phase3b_plan_approval で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません",
                ],
              };
            }
            if (decision === "unknown") {
              return {
                status: "fail",
                reasons: [
                  `phase3b_plan_approval の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は撤去済みのため request_changes を使ってください）`,
                ],
              };
            }
            const input = gateDecisionInput(ctx.gateAnswers, PLAN_APPROVAL_GATE_KEY);
            if (input === undefined || input.trim() === "") {
              return {
                status: "fail",
                reasons: [
                  "phase3b_plan_approval の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする",
                ],
              };
            }
            if (ctx.loop.iteration >= ctx.loop.maxIterations) {
              // 最終反復で continue を返すと onExhausted=escalate で停止し loop 外ゲートへ届かない。
              // request_changes の追加入力を枯渇マーカーへ永続化して pass で脱出し、
              // loop 外の plan_approval_exhausted_gate と後続 step で再提示する。
              try {
                writeFileSync(
                  join(ctx.sessionDir, PLAN_APPROVAL_EXHAUSTED_MARKER),
                  `${JSON.stringify({ loop: PLAN_APPROVAL_LOOP_KEY, gate: PLAN_APPROVAL_GATE_KEY, iteration: ctx.loop.iteration, input: input.trim() })}\n`,
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
                  `上限到達（反復 ${ctx.loop.iteration}/${ctx.loop.maxIterations}）のため request_changes のまま plan_approval_cycle を抜け、${PLAN_APPROVAL_EXHAUSTED_KEY} で人間が受容・中断を判断します。未反映の差し戻し（gate:phase3b_plan_approval）: ${input}`,
                ],
              };
            }
            return {
              status: "continue",
              reasons: [
                "phase3b_plan_approval request_changes — rewind plan_approval_cycle to phase3_planner",
              ],
            };
          },
        },
      ], // plan_approval_cycle body
    },

    // -------------------------------------------------------------------
    // 承認上限判断（loop 外・枯渇時のみ提示）
    //   plan_approval_cycle が上限（3 反復）に達しても request_changes のままの
    //   場合のみ condition が true になり、人間が受容して後続へ進むか中断するかを選ぶ。
    //   human_gate は確認と回答保存のみを行い、巻き戻しは行わない。
    //   loop 外のため選択肢は approve/abort のみとし、request_changes は
    //   持たせない（巻き戻しが起きず記録上通過するだけの未配線選択肢になるため）。
    //   上限未達（approve 脱出）では skipped となり、Phase 4 へ進む。
    // -------------------------------------------------------------------
    {
      key: "plan_approval_exhausted_gate",
      phase: "承認上限判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: isPlanApprovalExhausted,
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
      // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: ["plan.md"],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "計画承認が上限（3 反復）に達しても修正要求（request_changes）のままです。loop は既に終了しているため、このゲートで計画立案へ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。未反映の差し戻し内容はセッション内の plan-approval-exhausted.json（request_changes 追加入力の永続化）と gate の回答履歴（phase3b_plan_approval）で確認してください。指摘を受容して調査へ進むか、中断するかを選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "受容して調査へ進む",
                desc: "未反映の指摘を残したまま Phase 4: 調査へ進む",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断", desc: "中断する" },
            ],
          },
        ],
      },
    },

    // -----------------------------------------------------------------------
    // Phase 4: 調査 (Researcher, orchestrate)
    // -----------------------------------------------------------------------
    {
      key: "phase4_researcher",
      phase: "Phase 4: 調査",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: [
              "承認されたすべての問いについて、Researcher SubAgent を並列起動し、調査を実行する。",
            ],
            criteria: ["auditResearcher が pass（evidence_rounds_exist / sources_present）"],
            approach: [
              {
                title: "事前準備",
                content: [
                  "plan.md で承認された問い（draft 状態）を approved に更新する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} question list --db-path ${ctx.artifactDbPath}\n# 表示された draft の問いをすべて approved に更新`,
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} question update --id <ID> --status approved --db-path ${ctx.artifactDbPath}`,
                  "```",
                  "",
                ],
              },
              {
                title: "手順",
                content: [
                  "1. research.db から approved 状態の questions を取得する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} question list --status approved --db-path ${ctx.artifactDbPath}`,
                  "```",
                  "",
                  "2. 各 question_id に対して `mt-deep-research-researcher` SubAgent を並列起動する（最大 5 同時）",
                  "   - 各 SubAgent には question_id、round_number、`db.ts snapshot --cycle research` の出力を渡す",
                  "   - 期待する成果物: evidence_rounds / sources / facts / off_topic_questions の一括保存",
                  "   - 保存は SubAgent が `db.ts evidence save --data '...'` で行う",
                  "   - 各 Researcher のループは最大 5 ラウンド",
                  "   - 担当する question_id 以外の調査結果を参照しない",
                  "",
                  "3. 各 Researcher 完了後、機械監査を実行する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} phase --phase researcher --db-path ${ctx.artifactDbPath} --question-id <ID>`,
                  "```",
                  "",
                  "4. 監査 NG の場合は該当 Researcher にフィードバック（最大 3 回まで再委譲）",
                  "5. 3 回を超えても NG の場合は人間に「範囲を狭める」「このまま進める」「中断する」を提示",
                ],
              },
            ],
            policy: [
              "- 全問いの調査が完了する前に次のフェーズに進まない",
              "- SubAgent に他の問いの調査結果を混入させない",
            ],
            output: [
              "外部通信（外部 URL 取得・SearXNG クエリ）の前に、送信先・データ・目的を宣言する（Researcher SubAgent にも遵守させる）",
            ],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `未反映の差し戻し（枯渇時・plan-approval-exhausted.json の永続化。なければなし）: ${exhaustedFeedbackLine(ctx.sessionDir)}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          return toCheckResult(auditResearcher(db));
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 5: research サイクル監査
    // -----------------------------------------------------------------------
    {
      key: "phase5_research_cycle_audit",
      phase: "Phase 5: research サイクル監査",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: [
              "research サイクル全体の機械監査を実行し、問題があれば Auditor に意味整合性評価を依頼する。",
            ],
            criteria: ["auditResearchCycle が pass"],
            approach: [
              {
                title: "手順",
                content: [
                  "1. 機械監査を実行する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
                  "```",
                  "",
                  "2. 監査が pass なら完了",
                  "3. 監査が fail/error の場合:",
                  "   - `mt-deep-research-auditor` SubAgent を呼び出して意味的整合性を評価",
                  "   - Auditor には `db.ts snapshot --cycle research` の出力を渡す",
                  "   - 監査結果は workflow engine の step_attempts に自動保存される",
                  "   - 必要に応じて Researcher に追加調査を依頼",
                  "",
                ],
              },
              {
                title: "監査コマンド",
                content: [
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
                  "```",
                ],
              },
            ],
            output: [
              "research サイクル監査の結果。fail/error 時は Auditor の評価と追加調査の依頼。",
            ],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const checks = auditResearchCycle(db);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 6: チェックポイント
    // -----------------------------------------------------------------------
    {
      key: "phase6_checkpoint",
      phase: "Phase 6: チェックポイント",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: ["off_topic_questions をユーザーに提示し、追加調査するか判断を仰ぐ。"],
            criteria: ["auditResearchCycle が pass（off_topic_resolved）"],
            approach: [
              {
                title: "手順",
                content: [
                  "1. off_topic_questions を取得する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle research --db-path ${ctx.artifactDbPath}`,
                  "```",
                  "",
                  "2. スナップショットの `off_topic_questions` を確認する",
                  "3. 各 off_topic_question の内容をユーザーに提示し、追加調査するか確認する",
                  "4. ユーザーの判断に基づいて `decision` を更新する:",
                  "   - `include`: 追加調査に含める → Researcher で追加調査",
                  "   - `exclude`: 対象外とする",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} evidence save --db-path ${ctx.artifactDbPath} --data '{"question_id": <ID>, "round_number": <N>, "off_topic_questions": [{"content": "...", "decision": "include"}]}'`,
                  "```",
                  "",
                  "5. ユーザーが `include` を選択した off_topic_question があれば、Researcher に追加調査を依頼する",
                ],
              },
            ],
            output: ["off_topic_questions へのユーザー判断（include/exclude）の反映。"],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          return toCheckResult(auditResearchCycle(db));
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 7: レポート作成 (Writer)
    // -----------------------------------------------------------------------
    {
      key: "phase7_writer",
      phase: "Phase 7: レポート作成",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "run_subagent",
        subagentType: "mt-deep-research-writer",
        readonly: false,
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, "report.md");
          const reportTemplate = join(import.meta.dir, "templates", "report.md");
          return buildStepPrompt({
            purpose: ["収集された調査結果をもとに report.md を作成・更新する。"],
            criteria: [
              "auditWriter が pass（report_md_exists / report_md_required_sections / report_md_has_citations / report_md_has_mermaid）",
            ],
            approach: [
              {
                title: "担当範囲",
                content: [
                  "- report.md の作成・更新（`" + reportTemplate + "` の構成に従う、mermaid 必須）",
                  "- 番号引用 `[N]` は sources.source_number と一致させる",
                  "- 情報源は `## 情報源の一覧` に含める",
                  "",
                ],
              },
              {
                title: "入力の取得",
                content: [
                  "`db.ts snapshot --cycle writer-reviewer` の出力を使用する。",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
                ],
              },
            ],
            output: [`report.md を ${reportPath} に書き出す。`],
            policy: [
              "- ファイルを直接編集しない（report.md は書き込み可）",
              "- 未解決の問い・次のアクション・中間まとめを含めない",
              "- SearXNG 信頼性注意書きを含めない",
              "- レポートの全文をセッションに出力しない（完了報告は簡潔に）",
            ],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md 出力先: ${reportPath}`,
              `report テンプレート: ${reportTemplate}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, "report.md");
          const checks = auditWriter(db, reportPath);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 8: レビュー (Reviewer, parallel)
    // -----------------------------------------------------------------------
    {
      key: "phase8_reviewer",
      phase: "Phase 8: レビュー",
      type: "parallel",
      maxRetries: 3,
      onFail: { action: "escalate" },
      parallel: {
        subtasks: (["coverage", "sources", "accuracy", "structure", "citations"] as const).map(
          (aspect) => ({
            key: `reviewer_${aspect}`,
            subagentType: "mt-deep-research-reviewer",
            readonly: true,
            buildPrompt: (ctx: PromptCtx) => {
              const reportPath = join(ctx.sessionDir, "report.md");
              const aspectDesc: Record<string, string> = {
                coverage: "調査範囲の網羅性：すべての問いがレポートでカバーされているか",
                sources: "情報源の品質：引用が適切で信頼性の高いソースが使われているか",
                accuracy: "事実の正確性：evidence とレポートの記述が一致しているか",
                structure: "構造の妥当性：必須セクションが揃い、論理的な流れになっているか",
                citations: "引用の整合性：番号引用 [N] が sources.source_number と一致しているか",
              };
              return buildStepPrompt({
                purpose: [`「${aspect}」観点で report.md をレビューする。`],
                criteria: [
                  "auditReviewer が pass（all_aspects_reviewed / all_reviews_have_findings）",
                ],
                approach: [
                  {
                    title: `観点説明: ${aspect}`,
                    content: [aspectDesc[aspect] ?? "", ""],
                  },
                  {
                    title: "入力の取得",
                    content: [
                      "以下のスナップショットから report.md と research.db の内容を取得する:",
                      "",
                      "```bash",
                      `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                      "```",
                    ],
                  },
                ],
                output: [
                  "`db.ts review save` で JSON を保存する。findings は以下のカテゴリで分類する:",
                  "- `must_fix`: 修正が必須の問題",
                  "- `research_needed`: 追加調査が必要な項目（`target_question_id` を必ず付与）",
                  "- `suggestions`: 任意の改善提案",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} review save --db-path ${ctx.artifactDbPath} --data '{ ... }'`,
                  "```",
                ],
                policy: ["- 担当観点以外の指摘を行わない", "- ファイルを直接編集しない"],
                input: [
                  `セッションディレクトリ: ${ctx.sessionDir}`,
                  `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
                  `report.md: ${reportPath}`,
                  `観点: ${aspect}`,
                ],
              });
            },
          }),
        ),
      },
      task: {
        action: "run_subagent",
        buildPrompt: (_ctx: PromptCtx) =>
          buildStepPrompt({ purpose: [], criteria: [], approach: [], output: [] }),
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const checks = auditReviewer(db);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 9: writer-reviewer サイクル監査 + 改善ループ
    // -----------------------------------------------------------------------
    {
      key: "phase9_writer_reviewer_cycle",
      phase: "Phase 9: writer-reviewer サイクル",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, "report.md");
          return buildStepPrompt({
            purpose: ["writer-reviewer サイクルの機械監査を実行し、問題があれば修正ループを回す。"],
            criteria: [
              "auditWriterReviewerCycle が pass（auditWriter + auditReviewer + no_unresolved_must_fix + research_needed_addressed）",
            ],
            approach: [
              {
                title: "手順",
                content: [
                  "1. 機械監査を実行する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
                  "",
                  "2. 監査が pass なら完了",
                  "",
                  "3. 監査が fail/error の場合、review_findings を集約する:",
                  "   - `db.ts snapshot --cycle writer-reviewer` で全 findings を取得",
                  "   - `must_fix` / `research_needed` / `suggestions` に分類",
                  "   - 重複や類似の指摘を統合",
                  "",
                  "4. `must_fix` がある場合:",
                  "   - 集約した must_fix を 1 つのプロンプトにまとめ、Writer に再委譲",
                  "   - `suggestions` のうち重要と判断したものも含める",
                  "   - Writer は `db.ts snapshot --cycle writer-reviewer` を再取得して report.md を更新",
                  "   - 修正後、全観点を再レビューする",
                  "   - 最大 3 回まで再委譲。3 回を超えたら人間に判断を仰ぐ",
                  "",
                  "5. `research_needed` がある場合:",
                  "   - `target_question_id` ごとにグルーピング",
                  "   - 問いごとに Researcher SubAgent を起動（`round_number` をインクリメント）",
                  "   - 追加調査後、全観点を再レビューする",
                  "   - 最大 3 回まで追加調査。3 回を超えたら人間に判断を仰ぐ",
                  "",
                  "6. 改善ループの結果は `iterations` テーブルに記録する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} iteration save --db-path ${ctx.artifactDbPath} --data '{"loop_number": 1, "iteration_type": "writer_fix", "summary": "..."}'`,
                  "```",
                  "",
                  "7. 修正ループ後、再度サイクル監査を実行する",
                ],
              },
            ],
            output: ["監査結果。未解決があれば `iterations` テーブルに記録した改善ループの結果。"],
            policy: [
              "- must_fix が残っているのに次のフェーズに進まない",
              "- Writer → Reviewer ループは 1 回の report.md 更新あたり最大 3 回まで",
            ],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md: ${reportPath}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, "report.md");
          const checks = auditWriterReviewerCycle(db, reportPath);
          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 10: 最終レポート確定
    // -----------------------------------------------------------------------
    {
      key: "phase10_finalize",
      phase: "Phase 10: 最終レポート確定",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, "report.md");
          return buildStepPrompt({
            purpose: ["report.md を最終更新し、lint を実行してレポートを確定する。"],
            criteria: [
              "auditWriterReviewerCycle が pass かつ lint が pass かつ report に禁止コンテンツ（次のアクション/未解決の問い/中間まとめ/SearXNG 信頼性）がないこと",
            ],
            approach: [
              {
                title: "手順",
                content: [
                  "1. `lint.ts` で report.md をフォーマット・lint する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "lint.ts")} --file ${reportPath}`,
                  "```",
                  "",
                  "2. 最終サイクル監査を実行する",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
                  "",
                  "3. lint エラーがある場合は Writer に明示的な修正を依頼（最大 3 回）",
                  "4. レポートに未解決の問い・次のアクション・中間まとめ・SearXNG 信頼性注意書きが含まれていないか確認",
                  "5. report.md 全文はセッションに出さない",
                ],
              },
            ],
            output: ["lint 済みの確定版 report.md。"],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md: ${reportPath}`,
            ],
          });
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, "report.md");
          const checks = auditWriterReviewerCycle(db, reportPath);

          const lintResult = Bun.spawnSync(
            ["bun", "run", join(SCRIPTS_DIR, "lint.ts"), "--file", reportPath],
            { stdout: "pipe", stderr: "pipe", timeout: 60_000, maxBuffer: 1024 * 1024 },
          );
          const lintStderr = lintResult.stderr.toString().slice(0, 2000);
          checks.push({
            check_name: "lint_passed",
            status: lintResult.exitCode === 0 ? "pass" : "fail",
            detail: lintResult.exitCode === 0 ? "lint passed" : `lint failed:\n${lintStderr}`,
          });

          const content = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null;
          if (content) {
            const forbiddenWords = [
              "次のアクション",
              "未解決の問い",
              "中間まとめ",
              "SearXNG 信頼性",
            ];
            const found = forbiddenWords.filter((w) => content.includes(w));
            checks.push({
              check_name: "report_no_forbidden_content",
              status: found.length === 0 ? "pass" : "fail",
              detail: found.length === 0 ? "no forbidden content" : `found: ${found.join(", ")}`,
            });
          }

          return toCheckResult(checks);
        } finally {
          db.close();
        }
      },
    },

    // -----------------------------------------------------------------------
    // Phase 11: 完了報告
    // -----------------------------------------------------------------------
    {
      key: "phase11_completion",
      phase: "Phase 11: 完了報告",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "run_command",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: ["調査が完了したことを簡潔に報告する。report.md の全文は出力しない。"],
            criteria: [],
            approach: [
              "以下の形式で完了メッセージを出力する:",
              "",
              `調査が完了しました。N 件の情報源を確認しました。レポートは ${join(ctx.sessionDir, "report.md")} に保存しました。`,
            ],
            output: ["調査完了の報告メッセージ。"],
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md: ${join(ctx.sessionDir, "report.md")}`,
            ],
          });
        },
      },
      check: (_ctx: CheckCtx): CheckResult => {
        return { status: "pass", reasons: ["completion acknowledged"] };
      },
    },
  ],
};

export default def;
