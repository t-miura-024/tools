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
import { join, dirname } from "node:path";
import fs from "node:fs";
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig } from "../_shared/mt-plan-init-config";
import {
  shellQuote,
  findArtifactText,
  readSessionFile,
  isRecord,
} from "../_shared/mt-review-helpers";
import { requireStepArtifacts } from "../_shared/artifact-check";

interface RepoInfo {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

// readRepoInfo は afterInit で生成される repo-info.json を消費する際に使用（ai-2:73 配線）
// 各 check で repoInfo の整合性を検証するために呼び出す
function readRepoInfo(artifacts: ArtifactRecord[], sessionDir: string): RepoInfo {
  const raw = findArtifactText(artifacts, REPO_INFO_KEY, sessionDir);
  if (!raw) throw new Error(`Artifact not found: ${REPO_INFO_KEY}`);
  return JSON.parse(raw) as RepoInfo;
}

// ---------------------------------------------------------------------------
// Constants — パス解決を os.homedir() と fileURLToPath に統一（ai-1:86, ai-2:288, arch-1:86）
// ---------------------------------------------------------------------------

const GRILL_MAP_KEY = "grill-map.md";
const ISSUE_BODY_KEY = "issue-body.md";
const REPO_INFO_KEY = "repo-info.json";
const ANALYSIS_KEY = "analysis.md";
const EVIDENCE_KEY = "evidence.json";
const REPORT_KEY = "report.md";
const BODY_DIFF_KEY = "body-diff.md";
const ISSUE_NUMBER_KEY = "issue-number.txt";
const mtGrillRoundsDir = join(os.homedir(), ".cursor", "skills", "mt-grill-rounds");
const planFormatDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Loop (human gate revise 置換) ヘルパー
// ---------------------------------------------------------------------------
//
// human_gate の revise 撤去に伴い、差し戻し→再作業→再提示は loop の continue
// 巻き戻しで再現する。旧 reviseTargetStep を loop 始点（body 先頭）に据える:
// confirm_analysis→grill、confirm_update→draft_body。
// 構成: loop 本体 [作業ステップ群＋ゲート＋judge 末尾]。
// judge（loop 末尾 check）が ctx.gateAnswers の当該ゲート decision を読み、
// approve→pass / request_changes→continue / abort→error / 未知・未回答→fail。
// request_changes の追加入力は loop 先頭 worker の prompt へ注入する
// （検証は軽量版: body 非空＋source 対応＝自ゲートの outcome 回答のみ読む）。
// 上限到達時は continue を返さない（onExhausted=escalate で停止すると loop 外へ
// 届かないため）。代わりに枯渇マーカーを残して pass で脱出し、loop 外の人間
// 判断ゲート（approve/abort）へ渡す。loop 内ゲートは無条件で毎反復再実行される
// ため skip による stale 回答は発生しない。judge は自ゲートの outcome 回答のみ
// 読み、他ゲートの回答は拾わない（幽霊差し戻し防止）。

const ANALYSIS_CYCLE_LOOP_KEY = "analysis_cycle";
const ANALYSIS_EXHAUSTED_GATE_KEY = "analysis_exhausted";
const ANALYSIS_CYCLE_EXHAUSTED_KEY = "analysis-cycle-exhausted.json";
const UPDATE_CYCLE_LOOP_KEY = "update_cycle";
const UPDATE_EXHAUSTED_GATE_KEY = "update_exhausted";
const UPDATE_CYCLE_EXHAUSTED_KEY = "update-cycle-exhausted.json";

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

function isLoopExhausted(sessionDir: string, markerKey: string, loopKey: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, markerKey), "utf-8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.loop === loopKey;
  } catch {
    return false;
  }
}

// loop 先頭 worker の prompt へ注入する差し戻しデータ行（見出しなし。raw 文字列
// prompt のため Section 化は不可。呼び出し側は ## 入力・## 手順の直前に配置する）。
// 初回実行（未回答・approve・入力空）は「なし」行を返す。捏造の "(追加入力なし)" は
// 作らない（欠落は judge が fail で止める）。行頭#（## 等）を含めないこと。
function reworkFeedbackSection(gateAnswers: GateAnswers, gateKey: string): string[] {
  const value = gateDecisionValue(gateAnswers, gateKey);
  const input = gateDecisionInput(gateAnswers, gateKey);
  if (value === "request_changes" && input !== undefined && input.trim() !== "") {
    return [
      `前回の差し戻し (gate:${gateKey}。loop 再実行時はこの指摘を反映する):`,
      `- ${gateKey}: ${input.trim()}`,
      "",
    ];
  }
  return [`前回の差し戻し (gate:${gateKey}):`, "- (なし。初回実行)", ""];
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
// Workflow Definition: mt-plan-update
// ---------------------------------------------------------------------------

const def: WorkflowDef = {
  id: "mt-plan-update",
  description:
    "既存Plan Issueを実行断面の事実走査で再検証し、grillで合意して更新するワークフロー。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
    // 追加: 必須スキルパス存在検証（ai-1:86）
    const grillSkill = join(mtGrillRoundsDir, "SKILL.md");
    if (!fs.existsSync(grillSkill)) {
      throw new Error(`mt-grill-rounds SKILL.md not found: ${grillSkill}`);
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
    // Loop: 分析サイクル（confirm_analysis の revise 置換。旧 reviseTargetStep=grill を始点に据える）
    //   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
    //   マーカーを残して pass で脱出し、loop 外の analysis_exhausted へ渡す。
    // -----------------------------------------------------------------
    {
      key: "analysis_cycle",
      phase: "分析サイクル",
      type: "loop",
      maxIterations: 3,
      onExhausted: "escalate",
      body: [
        // -----------------------------------------------------------------
        // Step 1: Grill Phase（事実収集 + 再検証grill）— 軽量バイパス削除（req-1:187）
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
              const grillMapPath = join(ctx.sessionDir, GRILL_MAP_KEY);
              const analysisPath = join(ctx.sessionDir, ANALYSIS_KEY);
              const evidencePath = join(ctx.sessionDir, EVIDENCE_KEY);

              return [
                "## 目的",
                "",
                "既存Plan Issueを実行断面の事実で再検証し、通常の設計grill(Why/What/How)に加えて3点セットの観点でユーザーと合意形成する。",
                "",
                "3点セット:",
                "- (a) 前提の有効性: Issue作成時点の前提が今も成り立つか",
                "- (b) 要件の変化・欠落: 時間経過や追記プロンプトで要件が変わった/増えたか",
                "- (c) より良い代替選択肢: 現状の実装・周辺変更を踏まえたより良い案がないか",
                "",
                ...reworkFeedbackSection(ctx.gateAnswers, "confirm_analysis"),
                "## 入力",
                "",
                "- tado起動時に渡された `issue` (URLまたは番号) と `prompt` (追記要件) を確認する。未指定ならユーザーに確認する。",
                "- `gh issue view <number> --json title,body,labels,state,url,comments` で既存Issueを取得する。",
                "- 追記プロンプトと既存Issue本文を突き合わせ、矛盾があれば後段のgrillで3案提示する。",
                "",
                "## 手順",
                "",
                "### 1. 事実収集（SubAgent並列・必須）",
                "",
                "grillの進行役は自分で推測せず、必ずSubAgentに事実収集を委譲する（mt-grill-rounds原則: 事実はSubAgentが見つける）。",
                "軽量判定による省略は禁止。追記が軽微でも必ず3観点のSubAgentを派遣し、evidence.json に走査証跡を残す。",
                "",
                "Issue本文・コメント・紐づくPR/ブランチからキーワード/モジュール名/用語を抽出し、grep/globで候補ファイルを列挙する。",
                "抽出結果をもとに、観点ごとにSubAgentを並列派遣する:",
                "- 前提検証 SubAgent: 該当コード/スキーマ/ドキュメント/ADRを走査し、前提が崩れた箇所と根拠（ファイルパス・行・コミット）を収集",
                "- 要件差分 SubAgent: 追記プロンプトと既存完了条件/アウトプット/方針の差分を抽出し、欠落・変更点を整理",
                "- 競合・代替 SubAgent: 同一ファイル/モジュール/スキーマ/APIへの重複変更、ADR矛盾、マイグレーション競合を検出し、代替案の候補を列挙",
                "",
                "結果はセッションディレクトリに集約する:",
                `- \`${EVIDENCE_KEY}\` (JSON): 必須 { files: [{path, reason, commit, query, tool, timestamp}], mode: "full" }、任意 { relatedIssues, relatedPRs, conflicts }（検出時のみ）。各ファイルの commit は \`git cat-file -e <commit>^{commit}\` で実在検証し、存在しないハッシュは除外する`,
                `- \`${ANALYSIS_KEY}\` (Markdown): 3章立てで整理`,
                "  - ## 前提の有効性",
                "  - ## 要件の変化・欠落",
                "  - ## 代替選択肢",
                "  各項目に重要度(Blocker/Warning/Info)と根拠リンク（ファイルパス・コミット・Issue）を付与。Blockerは必ず3案（Issue優先/プロンプト優先/統合案）を用意。",
                "",
                "証跡の透明性（ai-1:159）: evidence.json 各エントリに { query, tool, timestamp } を必須記録する。",
                "",
                "### 2. 分析サマリの作成",
                "",
                `分析結果（\`${ANALYSIS_KEY}\` + \`${EVIDENCE_KEY}\` のサマリ）を \`${analysisPath}\` と \`${evidencePath}\` に保存する。次の human_gate で人間が確認する。`,
                "",
                "### 3. 徹底ヒアリング（mt-grill-rounds準拠）",
                "",
                `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                "",
                "ヒアリングは mt-grill-rounds の方式に従って進める:",
                `- ライブ地図のパスは既定パスではなく \`${grillMapPath}\`（セッションディレクトリ配下）を明示的に指定し、このパスで地図を育成する`,
                "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
                "- 質問生成は `analysis.md` + `evidence.json` の事実を根拠にし、3点セットの観点チェックリストを必ずカバーする",
                "- 前提崩れBlockerは3案提示して選択を迫る。Warning以下は確認のみ",
                "- 回答をライブ地図へ反映した後にフロンティアを再計算し、次のラウンドを提示する",
                "- フロンティアが空になり、ユーザーが共通認識を確認するまでラウンドを継続する",
                "",
                "### 4. ライブ地図の最終確認",
                "",
                `ヒアリングの全決定がセッションディレクトリのライブ地図 \`${grillMapPath}\` に蒸留されていることを確認する。`,
                "地図は Markdown 入れ子リスト＋状態マーカー（`[確定]` / `[未決]` / `[保留]`）の単一ファイルとし、質疑ログなどの別ファイルは残さない。",
                "Why/What/Howが漏れなく扱われ、3点セットの観点も反映されていることを確認する。",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `[{"key": "${GRILL_MAP_KEY}", "path": "${grillMapPath}"}, {"key": "${ANALYSIS_KEY}", "path": "${analysisPath}"}, {"key": "${EVIDENCE_KEY}", "path": "${evidencePath}"}]`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            try {
              if (ctx.attemptResult.status !== "completed") {
                return { status: "error", reasons: [ctx.attemptResult.errors ?? "grill failed"] };
              }
              const grillMap =
                readSessionFile(ctx.sessionDir, GRILL_MAP_KEY) ??
                findArtifactText(ctx.artifacts, GRILL_MAP_KEY, ctx.sessionDir);
              if (!grillMap) return { status: "fail", reasons: [`${GRILL_MAP_KEY} not found`] };
              const analysis =
                readSessionFile(ctx.sessionDir, ANALYSIS_KEY) ??
                findArtifactText(ctx.artifacts, ANALYSIS_KEY, ctx.sessionDir);
              if (!analysis) return { status: "fail", reasons: [`${ANALYSIS_KEY} not found`] };
              const evidenceRaw =
                readSessionFile(ctx.sessionDir, EVIDENCE_KEY) ??
                findArtifactText(ctx.artifacts, EVIDENCE_KEY, ctx.sessionDir);
              if (!evidenceRaw) return { status: "fail", reasons: [`${EVIDENCE_KEY} not found`] };
              let evidence: any;
              try {
                evidence = JSON.parse(evidenceRaw);
              } catch {
                return { status: "fail", reasons: ["evidence.json is not valid JSON"] };
              }
              if (!Array.isArray(evidence.files) || evidence.files.length === 0)
                return {
                  status: "fail",
                  reasons: ["evidence.json: files must be non-empty array"],
                };
              // allow-list: mode は "full" のみ許可（req-1:187）
              if (evidence.mode !== "full") {
                return {
                  status: "fail",
                  reasons: [
                    `evidence.json mode must be "full" (got ${JSON.stringify(evidence.mode)}) — SubAgent scan is mandatory`,
                  ],
                };
              }
              for (const f of evidence.files) {
                if (!f.path || !f.query || !f.tool || !f.timestamp) {
                  return {
                    status: "fail",
                    reasons: ["evidence.json: each file must have {path,query,tool,timestamp}"],
                  };
                }
              }
              // repo-info.json の整合性も検証（ai-2:73 配線）
              try {
                readRepoInfo(ctx.artifacts, ctx.sessionDir);
              } catch (e) {
                return { status: "fail", reasons: [`repo-info.json invalid: ${String(e)}`] };
              }
              return { status: "pass", reasons: ["grill artifacts verified"] };
            } catch (e) {
              return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
            }
          },
        },

        // -----------------------------------------------------------------
        // Step 1b: 分析サマリの人間確認（第一ゲート）
        // -----------------------------------------------------------------
        {
          key: "confirm_analysis",
          phase: "分析確認",
          type: "human_gate",
          maxRetries: 1,
          onFail: { action: "abort" },
          humanGate: {
            presentArtifacts: [GRILL_MAP_KEY, ANALYSIS_KEY, EVIDENCE_KEY],
            outcomeQuestionKey: "decision",
            questions: [
              {
                key: "decision",
                title: "判定",
                type: "choice_with_input",
                choices: [
                  {
                    value: "approve",
                    label: "分析を承認してgrillへ進む",
                    desc: "走査結果が妥当。grill質問へ進む",
                    input: { required: false, maxLength: 500 },
                  },
                  {
                    value: "request_changes",
                    label: "走査をやり直す",
                    desc: "スコープが的外れ。grillに戻って再走査する（loop が grill 先頭へ巻き戻る）",
                    input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
                  },
                  { value: "abort", label: "中断" },
                ],
              },
            ],
          },
          check: (ctx: CheckCtx): CheckResult => {
            try {
              const grillMap =
                readSessionFile(ctx.sessionDir, GRILL_MAP_KEY) ??
                findArtifactText(ctx.artifacts, GRILL_MAP_KEY, ctx.sessionDir);
              const analysis =
                readSessionFile(ctx.sessionDir, ANALYSIS_KEY) ??
                findArtifactText(ctx.artifacts, ANALYSIS_KEY, ctx.sessionDir);
              const evidence =
                readSessionFile(ctx.sessionDir, EVIDENCE_KEY) ??
                findArtifactText(ctx.artifacts, EVIDENCE_KEY, ctx.sessionDir);
              if (!grillMap || !analysis || !evidence)
                return {
                  status: "fail",
                  reasons: ["confirm_analysis: required artifacts missing"],
                };
              return { status: "pass", reasons: [] };
            } catch (e) {
              return { status: "fail", reasons: [String(e)] };
            }
          },
        },

        // -----------------------------------------------------------------
        // Step 1c: 差し戻し判定（analysis_cycle の loop 末尾）
        //   confirm_analysis の gateAnswers を読んで分岐する loop の check。
        //   request_changes → 判定 `continue` で loop 先頭（grill）へ巻き戻る。
        //   上限到達時は枯渇マーカーを残して pass で脱出し、loop 外の
        //   analysis_exhausted へ渡す。4分岐に pass フォールバックは設けない。
        // -----------------------------------------------------------------
        {
          key: "judge_analysis",
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
                "confirm_analysis の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
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
              gateKey: "confirm_analysis",
              loopKey: ANALYSIS_CYCLE_LOOP_KEY,
              headKey: "grill",
              markerKey: ANALYSIS_CYCLE_EXHAUSTED_KEY,
              exhaustedKey: ANALYSIS_EXHAUSTED_GATE_KEY,
            }),
        },
      ],
    },

    // -----------------------------------------------------------------
    // Step 1d: 分析上限到達時の人間判断（loop 外）
    //   judge が枯渇マーカーを残した反復でのみ condition が true になり提示する。
    //   正常 pass 時は提示しない。選択肢は approve/abort のみとし、
    //   request_changes は持たせない（loop 外で continue を返すとエンジンが
    //   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
    // -----------------------------------------------------------------
    {
      key: "analysis_exhausted",
      phase: "分析上限到達判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: (ctx: ConditionCtx): boolean =>
        isLoopExhausted(ctx.sessionDir, ANALYSIS_CYCLE_EXHAUSTED_KEY, ANALYSIS_CYCLE_LOOP_KEY),
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [GRILL_MAP_KEY, ANALYSIS_KEY, EVIDENCE_KEY],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "分析サイクルが上限（3 反復）に達しても差し戻しが解消しませんでした。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。差し戻し内容が未反映のまま本文マッピングへ進むか、中断するかを選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "差し戻しを残したまま次へ進む",
                desc: "未反映の指摘を残したまま draft_body へ進む",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断" },
            ],
          },
        ],
      },
    },

    // -----------------------------------------------------------------
    // Loop: 更新サイクル（confirm_update の revise 置換。旧 reviseTargetStep=draft_body を始点に据える）
    //   maxIterations=3・onExhausted=escalate。上限到達時は judge が枯渇
    //   マーカーを残して pass で脱出し、loop 外の update_exhausted へ渡す。
    // -----------------------------------------------------------------
    {
      key: "update_cycle",
      phase: "更新サイクル",
      type: "loop",
      maxIterations: 3,
      onExhausted: "escalate",
      body: [
        // -----------------------------------------------------------------
        // Step 2: 本文マッピング（grill-map → plan-format）
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
              const planFormatPath = join(planFormatDir, "..", "_shared", "mt-plan-plan-format.md");

              return [
                "## 目的",
                "",
                "grillで合意した内容を plan-format にマッピングし、既存Issueを更新するための最終本文を確定する。",
                "",
                ...reworkFeedbackSection(ctx.gateAnswers, "confirm_update"),
                "## 手順",
                "",
                "### 1. 入力の読み込み",
                "",
                `セッションディレクトリの \`${GRILL_MAP_KEY}\`（ライブ地図）と \`${ANALYSIS_KEY}\` を読み込む。`,
                "`gh issue view <number> --json body,state,labels --jq .` で既存Issueの現行本文と状態も取得する（差分生成とガードのため）。",
                "",
                "### 2. 最終本文の確定",
                "",
                `plan-format.md（${planFormatPath}）に従い、Issue body の最終本文を確定する。`,
                "既存本文をベースに、grillで確定した変更を反映する。全面書き換えではなく、差分を最小にして更新する。",
                "必須セクション（`## 💭 背景` / `## ✅ 完了条件` / `## 📦 アウトプット` / `## 🧭 方針` / `## 🐿️ メモ` / `## 🔍 レビュー` / `## 🐢 履歴`）を維持する。",
                "`## 🧩 ミッション` が必要な場合はWave方式で定義する。`## 📄 ドキュメント` は該当する場合のみ。",
                "",
                "履歴の扱い:",
                "- 本文は最新計画で上書き更新する",
                "- 変更理由・前提の再検証メモは `## 🐿️ メモ` または `## 🐢 履歴` に軽量に追記する（重い専用セクションは設けない）",
                "- `## 🐢 履歴` には `- YYYY-MM-DD HH:mm [plan:update] <変更サマリ>` の形式でエントリを追記する（transition-plan.tsの形式に準拠）",
                "",
                `確定した本文をセッションディレクトリに \`${ISSUE_BODY_KEY}\` として書き出す。`,
                `既存本文との差分を \`${join(ctx.sessionDir, BODY_DIFF_KEY)}\` にも書き出す（updateステップでの人間確認用）。差分行数と変更セクションを evidence にも記録する。`,
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める:",
                "```json",
                `[{"key": "${ISSUE_BODY_KEY}", "path": "${join(ctx.sessionDir, ISSUE_BODY_KEY)}"}, {"key": "${BODY_DIFF_KEY}", "path": "${join(ctx.sessionDir, BODY_DIFF_KEY)}"}]`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
            },
          },
          check: (ctx: CheckCtx): CheckResult => {
            try {
              if (ctx.attemptResult.status !== "completed") {
                return {
                  status: "error",
                  reasons: [ctx.attemptResult.errors ?? "draft_body failed"],
                };
              }
              const body =
                readSessionFile(ctx.sessionDir, ISSUE_BODY_KEY) ??
                findArtifactText(ctx.artifacts, ISSUE_BODY_KEY, ctx.sessionDir);
              if (!body) return { status: "fail", reasons: [`${ISSUE_BODY_KEY} not found`] };
              if (!body.includes("## ✅ 完了条件") || !body.includes("## 🧭 方針")) {
                return { status: "fail", reasons: ["issue-body.md: 必須セクション欠落"] };
              }
              const diff =
                readSessionFile(ctx.sessionDir, BODY_DIFF_KEY) ??
                findArtifactText(ctx.artifacts, BODY_DIFF_KEY, ctx.sessionDir);
              if (!diff) return { status: "fail", reasons: [`${BODY_DIFF_KEY} not found`] };
              // 反映検証: 正規化後の全文照合・欠落許容0件（Blocker全件必須を含む。prefix照合や割合閾値は禁止）
              const grillMap =
                readSessionFile(ctx.sessionDir, GRILL_MAP_KEY) ??
                findArtifactText(ctx.artifacts, GRILL_MAP_KEY, ctx.sessionDir);
              if (grillMap) {
                const grillLines = grillMap.match(/\[確定\].*/g) ?? [];
                const normalizeDecision = (s: string): string =>
                  s
                    .normalize("NFKC")
                    .replace("[確定]", "")
                    .replace(/^\s*(?:#{1,6}\s+|[-*・]\s+|\d+[.)]\s+|>\s*)+/, "")
                    .trim()
                    .replace(/\s+/g, " ");
                const normalizedBody = body.normalize("NFKC").replace(/\s+/g, " ");
                const missing = grillLines
                  .map((line) => normalizeDecision(line))
                  .filter((text) => text.length > 0)
                  .filter((text) => !normalizedBody.includes(text));
                if (missing.length > 0) {
                  const blockerMissing = missing.filter((text) => /blocker/i.test(text));
                  return {
                    status: "fail",
                    reasons: [
                      `issue-body.md: grillMapの確定事項に未反映あり（${missing.length}件）${blockerMissing.length > 0 ? `［Blocker未反映 ${blockerMissing.length}件を含む］` : ""}: ${missing.slice(0, 5).join(" / ")}${missing.length > 5 ? " ..." : ""}`,
                    ],
                  };
                }
              }
              return { status: "pass", reasons: ["draft_body artifacts verified"] };
            } catch (e) {
              return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
            }
          },
        },

        // -----------------------------------------------------------------
        // Step 2b: 更新差分の人間確認（第二ゲート）
        // -----------------------------------------------------------------
        {
          key: "confirm_update",
          phase: "更新確認",
          type: "human_gate",
          maxRetries: 1,
          onFail: { action: "abort" },
          humanGate: {
            presentArtifacts: [ISSUE_BODY_KEY, BODY_DIFF_KEY, GRILL_MAP_KEY],
            outcomeQuestionKey: "decision",
            questions: [
              {
                key: "decision",
                title: "判定",
                type: "choice_with_input",
                choices: [
                  {
                    value: "approve",
                    label: "差分を承認して更新する",
                    desc: "body-diffが妥当。Issue更新へ進む",
                    input: { required: false, maxLength: 500 },
                  },
                  {
                    value: "request_changes",
                    label: "本文を修正する",
                    desc: "差分が誤り。draft_bodyに戻る（loop が draft_body 先頭へ巻き戻る）",
                    input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
                  },
                  { value: "abort", label: "中断" },
                ],
              },
            ],
          },
          check: (ctx: CheckCtx): CheckResult => {
            try {
              const body =
                readSessionFile(ctx.sessionDir, ISSUE_BODY_KEY) ??
                findArtifactText(ctx.artifacts, ISSUE_BODY_KEY, ctx.sessionDir);
              const diff =
                readSessionFile(ctx.sessionDir, BODY_DIFF_KEY) ??
                findArtifactText(ctx.artifacts, BODY_DIFF_KEY, ctx.sessionDir);
              const grillMap =
                readSessionFile(ctx.sessionDir, GRILL_MAP_KEY) ??
                findArtifactText(ctx.artifacts, GRILL_MAP_KEY, ctx.sessionDir);
              if (!body || !diff || !grillMap)
                return { status: "fail", reasons: ["confirm_update: required artifacts missing"] };
              return { status: "pass", reasons: [] };
            } catch (e) {
              return { status: "fail", reasons: [String(e)] };
            }
          },
        },

        // -----------------------------------------------------------------
        // Step 2c: 差し戻し判定（update_cycle の loop 末尾）
        //   confirm_update の gateAnswers を読んで分岐する loop の check。
        //   request_changes → 判定 `continue` で loop 先頭（draft_body）へ巻き戻る。
        //   上限到達時は枯渇マーカーを残して pass で脱出し、loop 外の
        //   update_exhausted へ渡す。4分岐に pass フォールバックは設けない。
        // -----------------------------------------------------------------
        {
          key: "judge_update",
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
                "confirm_update の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
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
              gateKey: "confirm_update",
              loopKey: UPDATE_CYCLE_LOOP_KEY,
              headKey: "draft_body",
              markerKey: UPDATE_CYCLE_EXHAUSTED_KEY,
              exhaustedKey: UPDATE_EXHAUSTED_GATE_KEY,
            }),
        },
      ],
    },

    // -----------------------------------------------------------------
    // Step 2d: 更新上限到達時の人間判断（loop 外）
    //   judge が枯渇マーカーを残した反復でのみ condition が true になり提示する。
    //   正常 pass 時は提示しない。選択肢は approve/abort のみとし、
    //   request_changes は持たせない（loop 外で continue を返すとエンジンが
    //   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
    // -----------------------------------------------------------------
    {
      key: "update_exhausted",
      phase: "更新上限到達判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: (ctx: ConditionCtx): boolean =>
        isLoopExhausted(ctx.sessionDir, UPDATE_CYCLE_EXHAUSTED_KEY, UPDATE_CYCLE_LOOP_KEY),
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [ISSUE_BODY_KEY, BODY_DIFF_KEY, GRILL_MAP_KEY],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "更新サイクルが上限（3 反復）に達しても差し戻しが解消しませんでした。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。差し戻し内容が未反映のまま Issue 更新へ進むか、中断するかを選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "差し戻しを残したまま更新へ進む",
                desc: "未反映の指摘を残したまま update_issue へ進む",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断" },
            ],
          },
        ],
      },
    },

    // -----------------------------------------------------------------
    // Step 3: Issue 更新（GitHub操作）
    // -----------------------------------------------------------------
    {
      key: "update_issue",
      phase: "Issue 更新",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const issueBodyQuoted = shellQuote(join(ctx.sessionDir, ISSUE_BODY_KEY));
          const issueNumberQuoted = shellQuote(join(ctx.sessionDir, ISSUE_NUMBER_KEY));
          return [
            "## 目的",
            "",
            "draft_bodyで確定した本文で既存Plan Issueを更新し、変更サマリを残す。",
            "",
            "## 手順",
            "",
            "### 0. 事前ガード（req-2:315 — codeで検証、promptでは参考）",
            "",
            "更新前に既存Issueの状態を検証する（logic-2:457 — Issue番号は `^[0-9]+$` で検証し `shellQuote` してから `gh` に渡す）:",
            "```bash",
            `ISSUE_NUMBER=$(cat ${shellQuote(join(ctx.sessionDir, ISSUE_NUMBER_KEY))} | tr -d '[:space:]')`,
            'if ! echo "$ISSUE_NUMBER" | grep -qE "^[0-9]+$"; then echo "invalid issue number: $ISSUE_NUMBER" >&2; exit 1; fi',
            `gh issue view "$ISSUE_NUMBER" --json state,labels,body,number,title,url --jq '{state,labels,body}'`,
            "```",
            "- `state` が `CLOSED` なら abort",
            "- Project Status が `done` の Issue は更新せず abort",
            "- 分解済み親（Sub Issueを持つ）の場合は警告を提示し、子との整合性を確認してから進む",
            "- `external/<repo>` ラベルが付与された Issue は対象repoが正しいか確認",
            "（check でも同様の検証を code で行うため、ここでの失敗は check で fail として検出される）",
            "",
            "### 1. 入力の読み込み",
            "",
            `セッションディレクトリの \`${ISSUE_BODY_KEY}\` と \`${GRILL_MAP_KEY}\`、\`${BODY_DIFF_KEY}\`, \`${EVIDENCE_KEY}\` を読み込む。`,
            "",
            "### 2. 楽観的ロック（logic-2:321 — codeでも検証）",
            "",
            "編集直前に現行本文のハッシュを取得し、edit前に再比較する（darwin 対応: sha256sum → shasum -a 256 フォールバック）:",
            "```bash",
            `SHA_CMD=$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")`,
            `BEFORE_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)`,
            `DRAFT_BODY_HASH=$($SHA_CMD ${issueBodyQuoted} | cut -d' ' -f1)`,
            `CURRENT_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)`,
            'if [ "$BEFORE_BODY" != "$CURRENT_BODY" ]; then echo "競合検出: 他者がIssueを更新しました。中断して body-diff を再生成してください" >&2; exit 1; fi',
            "```",
            "不一致なら中断し、draft_body に戻って body-diff を再生成する。（check でも hash 比較を再検証する）",
            "",
            "### 3. Issue 本文の更新",
            "",
            "```bash",
            `gh issue edit "$ISSUE_NUMBER" --body-file ${issueBodyQuoted}`,
            "```",
            "失敗時はリトライ前に `gh issue view --json body` で本文が更新済みか確認し、冪等性を担保する。",
            "",
            "### 4. 変更サマリの投稿（秘密マスキング: ai-2:330 — codeでも再検証）",
            "",
            "投稿前に secret スキャンを実行し、トークン・APIキー・内部URLをマスキングしてから投稿する:",
            "```bash",
            `sed -E 's/(gh[pous]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpras]-[A-Za-z0-9-]+|npm_[A-Za-z0-9_]+|Bearer [A-Za-z0-9._-]+|-----BEGIN.*PRIVATE KEY-----)/***REDACTED***/g' ${shellQuote(join(ctx.sessionDir, "summary.md"))} > ${shellQuote(join(ctx.sessionDir, "summary.masked.md"))}`,
            `gh issue comment "$ISSUE_NUMBER" --body-file ${shellQuote(join(ctx.sessionDir, "summary.masked.md"))}`,
            "```",
            "投稿は最小権限トークンで実行し、内容は人間が承認した差分サマリのみとする。（check でマスキング漏れを再スキャンする）",
            "マスク済みサマリを `summary.masked.md` として保存したことを report 時の `artifacts` に含める（申告漏れは check で fail になる）:",
            "```json",
            `[{"key": "${ISSUE_NUMBER_KEY}", "path": "${join(ctx.sessionDir, ISSUE_NUMBER_KEY)}"}, {"key": "summary.masked.md", "path": "${join(ctx.sessionDir, "summary.masked.md")}"}]`,
            "```",
            "",
            "### 5. ラベル付与",
            "",
            "`plan:update` ラベルが存在しなければ作成し、Issueに付与する:",
            "```bash",
            `gh label view "plan:update" --json name >/dev/null 2>&1 || gh label create "plan:update" --description "計画更新" --color "0e8a16"`,
            `gh issue edit "$ISSUE_NUMBER" --add-label "plan:update"`,
            "```",
            "失敗時は本文更新は成功しているため、ラベル付与のみリトライする。コメント重複投稿を避けるため、直前のコメント一覧を `gh issue view --json comments` で確認し、同一サマリが既に投稿済みならスキップする。",
            "既存の `kind/plan` ラベルは維持する。",
            "",
            "### 6. Issue番号の記録",
            "",
            "更新したIssue番号を `issue-number.txt` に記録する（reportで参照）。",
            "```bash",
            `echo "$ISSUE_NUMBER" > ${issueNumberQuoted}`,
            "```",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "${ISSUE_NUMBER_KEY}", "path": "${join(ctx.sessionDir, ISSUE_NUMBER_KEY)}"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        try {
          if (ctx.attemptResult.status !== "completed") {
            return {
              status: "error",
              reasons: [ctx.attemptResult.errors ?? "update_issue failed"],
            };
          }
          const issueNumber =
            readSessionFile(ctx.sessionDir, ISSUE_NUMBER_KEY) ??
            findArtifactText(ctx.artifacts, ISSUE_NUMBER_KEY, ctx.sessionDir);
          if (!issueNumber) return { status: "fail", reasons: [`${ISSUE_NUMBER_KEY} not found`] };
          const trimmedNumber = issueNumber.trim();
          // 修正: Issue番号の無害化（logic-2:457 shell injection 対応）
          if (!/^[0-9]+$/.test(trimmedNumber)) {
            return { status: "fail", reasons: [`invalid issue number: ${trimmedNumber}`] };
          }
          const body =
            readSessionFile(ctx.sessionDir, ISSUE_BODY_KEY) ??
            findArtifactText(ctx.artifacts, ISSUE_BODY_KEY, ctx.sessionDir);
          if (!body) return { status: "fail", reasons: [`${ISSUE_BODY_KEY} not verified`] };
          // 統一最低ライン: マスク済みサマリの申告・実在を強制
          const maskedCheck = requireStepArtifacts(ctx, [
            { key: "summary.masked.md", form: "markdown" },
          ]);
          if (maskedCheck.status !== "pass") return maskedCheck;
          // 追加: 事前ガードの code 検証（req-2:315, logic-2:321, req-2:596）
          try {
            const repoInfo = readRepoInfo(ctx.artifacts, ctx.sessionDir);
            if (!repoInfo.owner || !repoInfo.repo)
              return { status: "fail", reasons: ["repo-info.json invalid"] };
          } catch (e) {
            return { status: "fail", reasons: [`repo-info check failed: ${String(e)}`] };
          }
          // 事前ガード: gh で state 取得を試み、CLOSED は fail（code配線、promptは参考）
          try {
            const stateOut = execSync(
              `gh issue view ${shellQuote(trimmedNumber)} --json state --jq .state`,
              { encoding: "utf-8" },
            ).trim();
            if (stateOut === "CLOSED")
              return { status: "fail", reasons: ["issue is CLOSED — reopen required"] };
          } catch (e) {
            return {
              status: "error",
              reasons: [
                `gh issue state verification failed: ${e instanceof Error ? e.message : String(e)}`,
              ],
            };
          }
          // 秘密マスキング漏れの簡易スキャン（ai-2:330, logic-2:432 — promptと同一パターンに統一、Bearer/PrivateKey追加）
          const secretPattern =
            /(gh[pous]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpras]-[A-Za-z0-9-]+|npm_[A-Za-z0-9_]+|Bearer [A-Za-z0-9._-]+|-----BEGIN.*PRIVATE KEY-----)/;
          const bodiesToScan = [body];
          const bodyDiff = readSessionFile(ctx.sessionDir, BODY_DIFF_KEY);
          if (bodyDiff) bodiesToScan.push(bodyDiff);
          const summaryMasked = readSessionFile(ctx.sessionDir, "summary.masked.md");
          if (summaryMasked) bodiesToScan.push(summaryMasked);
          for (const b of bodiesToScan) {
            if (secretPattern.test(b)) {
              return { status: "fail", reasons: ["potential secret detected — masking required"] };
            }
          }
          // 楽観的ロックの code 検証（logic-2:536, req-2:596）— 現行 body と draft の hash 比較を試みる
          try {
            const currentBodyRaw = execSync(
              `gh issue view ${shellQuote(trimmedNumber)} --json body --jq .body`,
              { encoding: "utf-8" },
            );
            const currentHash = createHash("sha256").update(currentBodyRaw).digest("hex");
            const draftHash = createHash("sha256").update(body).digest("hex");
            if (currentHash === draftHash) {
              return {
                status: "fail",
                reasons: ["issue body is already up to date — no update needed"],
              };
            }
          } catch (e) {
            return {
              status: "error",
              reasons: [
                `issue body hash verification failed: ${e instanceof Error ? e.message : String(e)}`,
              ],
            };
          }
          return { status: "pass", reasons: [`updated issue ${trimmedNumber}`] };
        } catch (e) {
          return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
        }
      },
    },

    // -----------------------------------------------------------------
    // Step 4: レポート
    // -----------------------------------------------------------------
    {
      key: "report",
      phase: "レポート",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const reportPath = join(ctx.sessionDir, REPORT_KEY);

          return [
            "## 目的",
            "",
            "更新内容をレポートにまとめ、Issueコメントとセッションディレクトリに残す。",
            "",
            "## 手順",
            "",
            "### 1. レポート生成",
            "",
            `セッションディレクトリの \`${GRILL_MAP_KEY}\`, \`${ANALYSIS_KEY}\`, \`${EVIDENCE_KEY}\`, \`${BODY_DIFF_KEY}\`, \`${ISSUE_NUMBER_KEY}\` をもとに、\`${REPORT_KEY}\` を生成する。`,
            "",
            "レポートは以下の必須見出しを持つこと:",
            "- `## 走査サマリ`",
            "- `## 前提崩れ一覧`",
            "- `## grill 決定ログ`",
            "- `## 更新差分サマリ`",
            "- `## 次アクション`",
            "",
            "内容:",
            "- 走査サマリ（対象ファイル数、関連Issue/PR、走査手法、evidence の query/tool/timestamp）",
            "- 前提崩れ一覧（Blocker/Warning/Info、各項目の重要度と根拠リンク）",
            "- grill決定ログ（主要な決定と理由、未決/保留があれば明記）",
            "- 更新差分サマリ（body-diff.mdの要約、差分行数）",
            "- 次アクション（残論点、後続タスク、mt-plan-runで実行可能か）",
            "- Issue URL・番号、対象repo、付与ラベル",
            "",
            "### 2. 完了報告",
            "",
            "以下を報告する:",
            "- Issue URL・番号",
            "- 対象repo",
            "- 更新されたセクション",
            "- 付与ラベル（plan:update）",
            "- レポート保存先（セッションディレクトリ）",
            "- 次のステップ（必要に応じて mt-plan-run で実行）",
            "",
            "## 成果物",
            "",
            "report 時の `artifacts` に以下を含める:",
            "```json",
            `{"key": "${REPORT_KEY}", "path": "${reportPath}"}`,
            "```",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        try {
          if (ctx.attemptResult.status !== "completed") {
            return { status: "error", reasons: [ctx.attemptResult.errors ?? "report failed"] };
          }
          const report =
            readSessionFile(ctx.sessionDir, REPORT_KEY) ??
            findArtifactText(ctx.artifacts, REPORT_KEY, ctx.sessionDir);
          if (!report) return { status: "fail", reasons: [`${REPORT_KEY} not found`] };
          // 統一最低ライン: 必須見出しを含めることを強制
          const minimum = requireStepArtifacts(ctx, [
            {
              key: REPORT_KEY,
              form: "markdown",
              sections: [
                "## 走査サマリ",
                "## 前提崩れ一覧",
                "## grill 決定ログ",
                "## 更新差分サマリ",
                "## 次アクション",
              ],
            },
          ]);
          if (minimum.status !== "pass") return minimum;
          return { status: "pass", reasons: ["report generated"] };
        } catch (e) {
          return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
        }
      },
    },
  ],
};

export default def;
