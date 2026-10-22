import type { CheckCtx, CheckResult, PromptCtx, StepCtx } from "tado";
import type { ArtifactInput } from "tado/types/artifact.ts";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { isTMiura024 } from "../../helper/is-tmiura024.ts";
import { listReviewTargets } from "../../helper/list-review-targets.ts";
import {
  normalizeReviewFindings,
  parseRawReviewFindings,
  readPlanReviewFindings,
  validatePlanReviewFindings,
} from "../../helper/review-findings.ts";
import { renderReviewBody } from "../../helper/render-review-body.ts";
import { readReviewRound, writeReviewRound } from "../../helper/review-round.ts";
import {
  FROM_ISSUE_KEY,
  REVIEW_BODY_KEY,
  REVIEW_DECISIONS_KEY,
  REVIEW_FINDINGS_KEY,
} from "../../helper/review-limits.ts";
import { requireChildReviewIfChildrenExist } from "../../helper/require-child-review-if-children-exist.ts";

const ISSUE_BODY_KEY = "issue-body.md";
const planFormatPath = join(import.meta.dir, "..", "..", "..", "shared", "plan-plan-format.md");
const mtDomainModelingDir = join(import.meta.dir, "..", "..", "..", "mt-domain-modeling");

// -----------------------------------------------------------------
// Step 3: 独立レビュー
//   起草者から独立した mt-plan-reviewer にレビューさせ、review-findings.json を
//   機械可読な契約として保存する。review-body.md は afterStep が findings から
//   決定論的に生成する（LLM に Markdown を書かせない）。
// -----------------------------------------------------------------
export const reviewBodyStep: TaskStepDef = {
  key: "review-body",
  phase: "独立レビュー",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);
      const targetList = listReviewTargets(ctx.sessionDir);
      if (targetList.error) {
        throw new Error(`レビュー対象の列挙に失敗しました: ${targetList.error}`);
      }

      const decisionsPath = join(ctx.sessionDir, REVIEW_DECISIONS_KEY);
      const fromIssuePath = join(ctx.sessionDir, FROM_ISSUE_KEY);
      const findingsPath = join(ctx.sessionDir, REVIEW_FINDINGS_KEY);

      return buildStepPrompt({
        purpose: [
          "起草者から独立したレビュアー SubAgent `mt-plan-reviewer` に Issue body をレビューさせ、機械可読な review-findings.json を生成する。",
          "このステップのエージェント自身はレビューしない。指摘の取捨選択・修正もしない。",
        ],
        criteria: [
          "`review-findings.json` がレビュアーの JSON 出力をそのまま保存している",
          "`reviewedTargets` に issue-body.md と全子 body が含まれている",
          "レビュアーの指摘に evidence が付いている",
        ],
        approach: [
          {
            title: "1. 入力の確認",
            content: [
              `セッションディレクトリの \`${ISSUE_BODY_KEY}\`（親 body）を確認する。`,
              "分解モード（子 body `issue-body-<n>.md` が存在する場合）は全件を必須レビュー対象とする。",
              `判定基準として plan-format.md（${planFormatPath}）を参照する。`,
              ...(existsSync(decisionsPath)
                ? [`ユーザーの確定決定: ${decisionsPath}（レビュアーに渡す）`]
                : []),
              ...(existsSync(fromIssuePath)
                ? [`元 Issue: ${fromIssuePath}（from-Issue フローの取り込み漏れ確認に使う）`]
                : []),
            ],
          },
          {
            title: "2. 独立レビュアーの起動",
            content: [
              'Task ツールで `subagent_type = "mt-plan-reviewer"` を 1 回だけ起動する。',
              "",
              "SubAgent には以下を渡す:",
              `- セッションディレクトリ: ${ctx.sessionDir}`,
              `- 対象ファイル（すべて読む）: ${targetList.targets.join(", ")}`,
              `- plan-format.md: ${planFormatPath}`,
              ...(existsSync(decisionsPath)
                ? [`- ユーザーの確定決定: ${decisionsPath}`]
                : ["- ユーザーの確定決定: なし（初回レビュー）"]),
              ...(existsSync(fromIssuePath) ? [`- 元 Issue: ${fromIssuePath}`] : []),
              ...(withDocs
                ? [
                    `- mt-domain-modeling: ${mtDomainModelingDir}（C 観点を適用する）`,
                    `- Gherkin フォーマット: ${join(mtDomainModelingDir, "GHERKIN-FORMAT.md")}`,
                  ]
                : ["- C 観点（思想・ポリシー＋ADR）: 本 repo ではスキップする"]),
              "- 今回のレビューは独立レビュー。起草者の会話・意図・自己評価を推測せず、成果物とユーザー決定だけを根拠にする",
              "- 指摘には必ず evidence（本文の引用または正確な位置）を付ける。根拠のない must は禁止",
              "- must は計画の実行・品質を阻害する欠陥に限定する",
              "- ユーザーが reject した指摘を再指摘しない（決定と矛盾する場合・新しい問題を除く）",
              "- ファイルを編集しない。意思決定をしない",
              "- `reviewedTargets` には issue-body.md と子 body のみを列挙する（plan-format.md / from-issue.md / review-decisions.md は含めない）",
              "- 指摘は findings 配列の JSON で返す（形式は `mt-plan-reviewer` の定義に従う）",
              "",
              "レビュアーの指摘を自分で評価・取捨選択・修正しない。",
            ],
          },
          {
            title: "3. 出力の保存",
            content: [
              `SubAgent の出力から JSON オブジェクトだけを取り出し、\`${findingsPath}\` にそのまま保存する。`,
              "要約・取捨選択・並べ替え・追記をしない。コードフェンスを含めない。",
              `\`${REVIEW_BODY_KEY}\` は afterStep が review-findings.json から決定論的に生成するため、このステップでは作成しない。`,
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に review-findings.json を含める:",
          "```json",
          `{"key": "${REVIEW_FINDINGS_KEY}", "path": "${findingsPath}"}`,
          "```",
        ],
        policy: [
          "レビュアーの指摘を自分で評価・修正しない",
          "issue-body.md / 子 body を編集しない（修正は draft-body が行う）",
          "review-findings.json はレビュアーの出力をそのまま保存する",
          "workflow.db のループ制御に触れない",
        ],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `対象ファイル: ${targetList.targets.join(", ")}`,
        ],
      });
    },
  },
  afterStep: async (ctx: StepCtx): Promise<ArtifactInput[]> => {
    const findingsPath = join(ctx.sessionDir, REVIEW_FINDINGS_KEY);
    let raw: string;
    try {
      raw = readFileSync(findingsPath, "utf-8");
    } catch (error) {
      throw new Error(
        `review-findings.json の読み取りに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = parseRawReviewFindings(raw);
    if (!parsed.valid || !parsed.parsed) {
      throw new Error(
        `レビュアー出力の検証に失敗しました: ${parsed.error ?? "invalid review findings"}`,
      );
    }
    const round = readReviewRound(ctx.sessionDir) + 1;
    const cycleRound = ctx.loop?.iteration ?? 1;
    const normalized = normalizeReviewFindings(parsed.parsed, round, cycleRound);
    const validation = validatePlanReviewFindings(JSON.stringify(normalized));
    if (!validation.valid || !validation.parsed) {
      throw new Error(
        `正規化した review-findings.json の検証に失敗しました: ${validation.error ?? "invalid review findings"}`,
      );
    }

    writeFileSync(findingsPath, `${JSON.stringify(validation.parsed, null, 2)}\n`, "utf-8");
    writeReviewRound(ctx.sessionDir, round);
    const reviewBodyPath = join(ctx.sessionDir, REVIEW_BODY_KEY);
    writeFileSync(reviewBodyPath, renderReviewBody(validation.parsed), "utf-8");

    return [
      { key: REVIEW_FINDINGS_KEY, path: findingsPath },
      { key: REVIEW_BODY_KEY, path: reviewBodyPath },
    ];
  },
  check: (ctx: CheckCtx): CheckResult => {
    const base = requireStepArtifacts(ctx, [
      {
        key: ISSUE_BODY_KEY,
        form: "markdown",
        sections: ["## ✅ 完了条件", "## 🧭 方針"],
      },
      {
        key: REVIEW_FINDINGS_KEY,
        form: "json",
        keys: ["reviewer", "round", "cycleRound", "reviewedTargets", "findings", "counts"],
      },
      {
        key: REVIEW_BODY_KEY,
        form: "markdown",
        sections: ["## レビュー結果", "## 指摘一覧"],
        patterns: [/(🚨 must|⚠️ should|💡 want|指摘なし)/],
      },
    ]);
    if (base.status !== "pass") return base;

    const findings = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
    const parsed = findings.parsed;
    if (!findings.valid || parsed === undefined) {
      return {
        status: "fail",
        reasons: [
          `review-findings.json の検証に失敗しました: ${findings.error ?? "invalid findings"}`,
        ],
      };
    }
    const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);
    if (!withDocs && parsed.findings.some((finding) => finding.perspective === "C")) {
      return {
        status: "fail",
        reasons: [
          "review-findings.json: C 観点（思想・ポリシー＋ADR）は t-miura-024 以外ではスキップする必要があります",
        ],
      };
    }
    const targetList = listReviewTargets(ctx.sessionDir);
    if (targetList.error) {
      return { status: "fail", reasons: [targetList.error] };
    }
    const missing = targetList.targets.filter((target) => !parsed.reviewedTargets.includes(target));
    if (missing.length > 0) {
      return {
        status: "fail",
        reasons: [
          `review-findings.json: reviewedTargets に対象ファイル（${missing.join(", ")}）が含まれていません`,
        ],
      };
    }
    const unexpected = parsed.reviewedTargets.filter(
      (target) => !targetList.targets.includes(target),
    );
    if (unexpected.length > 0) {
      return {
        status: "fail",
        reasons: [
          `review-findings.json: reviewedTargets に存在しないファイル（${unexpected.join(", ")}）が含まれています`,
        ],
      };
    }
    const cycleRound = ctx.loop?.iteration ?? 1;
    if (parsed.cycleRound !== cycleRound) {
      return {
        status: "fail",
        reasons: [
          `review-findings.json の cycleRound=${parsed.cycleRound} が内側ループ iteration=${cycleRound} と一致しません`,
        ],
      };
    }
    return requireChildReviewIfChildrenExist(ctx);
  },
};
