import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult, InitCtx, AfterInitResult } from "tado";
import { buildStepPrompt } from "tado/prompt";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
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
              "### 1. ヒアリング本体",
              "",
              "質問は一度に 1 つ。ユーザーが「十分」と宣言するまで継続する。",
              "質問の際は番号付きの 3 つの選択肢を提示し、各選択肢に 5 段階の推奨度（例: ★★★★☆）と理由を添える。",
              "",
              "- **ユーザー決定領域:** 背景、目的、前提知識、制約、スコープ — 推測で埋めず質問で確認",
              "- **AI 提案領域:** 調査方針、観点、制約の提案 — 選択肢・推奨度・理由を添えて提案",
              "",
              "### 2. 軽量な調査で済む場合の判断",
              "",
              "軽量な一次資料調査だけで足りる場合は、フル Deep Research の前に次を試してよい:",
              "1. 公式 docs / 仕様 / ソースコードなど一次資料だけを当たる",
              "2. 主張ごとに出典を付ける",
              "3. リポジトリの既存メモ規約に合わせて 1 ファイルへ残す",
              "",
              "この場合、フル Deep Research を継続するかユーザーに確認する。",
              "",
              "### 3. hearing.md の書き出し",
              "",
              `ヒアリング結果を ${hearingPath} に書き出す（背景・目的・前提知識・制約・スコープを構造化）。`,
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

    // -----------------------------------------------------------------------
    // Phase 3: 計画立案 (Planner)
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
              "### 担当範囲",
              "",
              "- plan.md の作成（`templates/plan.md` の構成に従う、mermaid 必須）",
              "- questions テーブルへの問い登録（`db.ts question create` を使用）",
              "- hearing.md（事前ヒアリング結果）を読み、背景・目的・前提知識・制約を plan.md に反映する",
              "",
              "### 実行コマンド",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question create --content "..." --order 1 --db-path ${ctx.artifactDbPath}`,
              "```",
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
    // Phase 3b: 計画承認
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
        reviseTargetStep: "phase3_planner",
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
                value: "revise",
                label: "修正が必要",
                desc: "Planner を再実行する",
                input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
              },
              { value: "abort", label: "中断" },
            ],
          },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
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
              "### 事前準備",
              "",
              "plan.md で承認された問い（draft 状態）を approved に更新する:",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question list --db-path ${ctx.artifactDbPath}`,
              "# 表示された draft の問いをすべて approved に更新",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question update --id <ID> --status approved --db-path ${ctx.artifactDbPath}`,
              "```",
              "",
              "### 手順",
              "",
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
              "### 手順",
              "",
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
              "### 監査コマンド",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle research --db-path ${ctx.artifactDbPath}`,
              "```",
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
              "### 手順",
              "",
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
              "### 担当範囲",
              "",
              "- report.md の作成・更新（`" + reportTemplate + "` の構成に従う、mermaid 必須）",
              "- 番号引用 `[N]` は sources.source_number と一致させる",
              "- 情報源は `## 情報源の一覧` に含める",
              "",
              "### 入力の取得",
              "",
              "`db.ts snapshot --cycle writer-reviewer` の出力を使用する。",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
              "```",
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
                  `### 観点説明: ${aspect}`,
                  "",
                  aspectDesc[aspect] ?? "",
                  "",
                  "### 入力の取得",
                  "",
                  "以下のスナップショットから report.md と research.db の内容を取得する:",
                  "",
                  "```bash",
                  `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
                  "```",
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
          buildStepPrompt({ purpose: [], criteria: [], approach: [] }),
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
              "### 手順",
              "",
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
              "### 手順",
              "",
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
            input: [
              `セッションディレクトリ: ${ctx.sessionDir}`,
              `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
              `report.md: ${reportPath}`,
            ],
          });
        },
      },
      check: async (ctx: CheckCtx): Promise<CheckResult> => {
        if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
        const db = openResearchDb(ctx.artifactDbPath);
        try {
          const reportPath = join(ctx.sessionDir, "report.md");
          const checks = auditWriterReviewerCycle(db, reportPath);

          const lintResult = await $`bun run ${join(SCRIPTS_DIR, "lint.ts")} --file ${reportPath}`
            .nothrow()
            .quiet();
          checks.push({
            check_name: "lint_passed",
            status: lintResult.exitCode === 0 ? "pass" : "fail",
            detail:
              lintResult.exitCode === 0
                ? "lint passed"
                : `lint failed:\n${lintResult.stderr.toString()}`,
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
