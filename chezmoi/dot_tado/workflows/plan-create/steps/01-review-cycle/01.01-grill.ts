import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSessionFile } from "tado/artifacts";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { isTMiura024 } from "../../helper/is-tmiura024.ts";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";
import {
  extractMarkdownSection,
  formatMustFindingsForGrill,
  hasFindingDecision,
  hasHumanDecision,
  readPlanReviewFindings,
} from "../../helper/review-findings.ts";
import {
  FROM_ISSUE_KEY,
  REVIEW_DECISIONS_KEY,
  REVIEW_FINDINGS_KEY,
} from "../../helper/review-limits.ts";

const mtGrillDir = join(import.meta.dir, "..", "..", "..", "mt-grill");
const mtDomainModelingDir = join(import.meta.dir, "..", "..", "..", "mt-domain-modeling");
const REVIEW_GATE_KEY = "review-gate";
const REVIEW_FIX_EXHAUSTED_GATE_KEY = "review-fix-exhausted";

// ---------------------------------------------------------------------------
// Loop 構造は steps/01-review-cycle/index.ts を参照。
// grill は初回ヒアリングとレビュー指摘への追加ヒアリングを兼ねる。
// AI は計画を決定・修正しない。ユーザーの回答だけを review-decisions.md に記録する。
// ---------------------------------------------------------------------------

export const grillStep: TaskStepDef = {
  key: "grill",
  phase: "Grill Phase",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);

      const findingsPath = join(ctx.sessionDir, REVIEW_FINDINGS_KEY);
      const hasFindingsFile = existsSync(findingsPath);
      let mustSection = "";
      let reviewRound: number | undefined;
      if (hasFindingsFile) {
        const findings = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
        if (!findings.valid || !findings.parsed) {
          throw new Error(
            `review-findings.json を検証できないため grill を実行できません: ${findings.error ?? "invalid findings"}`,
          );
        }
        mustSection = formatMustFindingsForGrill(findings.parsed);
        reviewRound = findings.parsed.round;
      }
      const hasMust = mustSection.length > 0;

      const reviewGateValue = gateDecisionValue(ctx.gateAnswers, REVIEW_GATE_KEY);
      const reviewGateInput = gateDecisionInput(ctx.gateAnswers, REVIEW_GATE_KEY);
      const hasHumanFeedback =
        reviewGateValue === "request_changes" &&
        reviewGateInput !== undefined &&
        reviewGateInput.trim() !== "";
      const retryInput = gateDecisionInput(ctx.gateAnswers, REVIEW_FIX_EXHAUSTED_GATE_KEY);

      const hearingSection = withDocs
        ? [
            {
              title: "2. 徹底ヒアリング + ドメインモデリング",
              content: [
                `mt-grill スキル（${join(mtGrillDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                "",
                `加えて mt-domain-modeling スキル（${join(mtDomainModelingDir, "SKILL.md")}）を参照し、その規律をすべて適用する。`,
                "",
                "確定した用語・ADR 案・Gherkin シナリオ案は次段 draft-body で `## 📄 ドキュメント` に埋め込む前提で確定させること（このフェーズでは repo へ書き込まない）。",
                "Gherkin シナリオは既存の `.feature` とステップ定義を読んだうえで確定し、draft-body がファイル全文を再構成できる状態にする。",
                `フォーマットは ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} / ${join(mtDomainModelingDir, "ADR-FORMAT.md")} / ${join(mtDomainModelingDir, "GHERKIN-FORMAT.md")} に従う。`,
              ],
            },
          ]
        : [
            {
              title: "2. 徹底ヒアリング",
              content: [
                `mt-grill スキル（${join(mtGrillDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
              ],
            },
          ];

      const outputLines: string[] = [];
      const decisionsArtifactLine = [
        `${REVIEW_DECISIONS_KEY} を作成・更新し、report 時の \`artifacts\` に含める:`,
        "```json",
        `{"key": "${REVIEW_DECISIONS_KEY}", "path": "${join(ctx.sessionDir, REVIEW_DECISIONS_KEY)}"}`,
        "```",
        "",
      ];
      if (hasMust) {
        outputLines.push(
          ...decisionsArtifactLine,
          `形式（累積。既存の他セクションは保持し、同じ見出しのセクションだけ置換する。過去の決定を消さない）。今回のラウンドは R${reviewRound}。`,
          "",
          "```markdown",
          `## レビュー R${reviewRound}`,
          "",
          `### R${reviewRound}-F1: <短いタイトル>`,
          "- 指摘: <レビュアーの problem>",
          "- 種別: decision | mechanical",
          "- 決定: adopt | reject | modify",
          "- 内容: <ユーザーの決定内容。修正が必要なら具体的に>",
          "```",
          "",
        );
      }
      if (hasHumanFeedback) {
        if (!hasMust) {
          outputLines.push(...decisionsArtifactLine);
        }
        outputLines.push(
          "人間差し戻しは `## 人間差し戻し` セクションに以下を記録する:",
          "",
          "```markdown",
          "## 人間差し戻し",
          "- 入力: <review-gate の request_changes 入力>",
          "- 決定: adopt | reject | modify",
          "- 内容: <ユーザーの決定内容>",
          "```",
          "",
        );
      }
      if (outputLines.length === 0) {
        outputLines.push(
          "成果物なし。中間ファイルは残さない。確定内容は次段 draft-body で `issue-body.md` に集約する。",
        );
      } else if (existsSync(join(ctx.sessionDir, FROM_ISSUE_KEY))) {
        outputLines.push(
          `${FROM_ISSUE_KEY} も report 時の artifacts に含める:`,
          "```json",
          `{"key": "${FROM_ISSUE_KEY}", "path": "${join(ctx.sessionDir, FROM_ISSUE_KEY)}"}`,
          "```",
        );
      }

      return buildStepPrompt({
        purpose: hasMust
          ? [
              "独立レビュアーが検出した must 指摘について、ユーザーに確認し、決定を review-decisions.md に記録する。",
              "AI は計画の意思決定をしない。ユーザーの回答だけを記録する。計画本文の修正は次段 draft-body が行う。",
            ]
          : [
              "計画の全側面についてユーザーと共通理解に達するまでヒアリングを行う（Grill Phase）。",
              ...(hasHumanFeedback
                ? [
                    "前回の人間差し戻しについてもユーザーに確認し、決定を review-decisions.md に記録する。",
                  ]
                : []),
            ],
        criteria: hasMust
          ? [
              "must 指摘すべてについてユーザーの決定が review-decisions.md に記録されている",
              "AI が計画本文を修正していない",
            ]
          : [
              "フロンティア（前提がすべて確定済みの決定）が空になり、ユーザーが共通理解を確認した",
              ...(hasHumanFeedback
                ? ["人間差し戻しへの決定が review-decisions.md に記録されている"]
                : []),
            ],
        approach: [
          ...(hasMust
            ? [
                {
                  title: "1. レビュー must 指摘への確認",
                  content: [
                    "以下の must 指摘すべてについてユーザーに確認する。1 件も省略しない。",
                    "",
                    mustSection,
                    "",
                    "- 各指摘を mt-grill の質問形式（番号付き 3 案、5 段階の星評価、理由）で提示する。レビュアーの `選択肢候補` は材料であり、そのまま貼らない。",
                    "- `type: mechanical` の指摘は「この修正内容でよいか」の確認として提示する。",
                    "- `type: decision` の指摘は、スコープ・優先度・意図・トレードオフをユーザーに選んでもらう。",
                    "- 同一ラウンドの質問はまとめて提示し、回答を待ってから次へ進む。",
                    "- AI が決定・修正しない。ユーザーの回答だけを記録する。",
                    "- review-decisions.md で既に決定済みの事項を再質問しない（新しい根拠がある場合を除く）。",
                  ],
                },
              ]
            : []),
          ...(hasHumanFeedback
            ? [
                {
                  title: "人間差し戻しへの確認",
                  content: [
                    `前回の人間差し戻し（gate:${REVIEW_GATE_KEY}）:`,
                    `- ${reviewGateInput!.trim()}`,
                    "",
                    "この差し戻しについてユーザーに確認し、決定を review-decisions.md の `## 人間差し戻し` セクションに記録する。AI が差し戻しを解釈して勝手に修正しない。",
                  ],
                },
              ]
            : []),
          ...(retryInput !== undefined && retryInput.trim() !== ""
            ? [
                {
                  title: "追加ラウンドの指示",
                  content: [
                    `review-fix-exhausted で入力された追加指示:`,
                    `- ${retryInput.trim()}`,
                    "",
                    "この指示もユーザーの決定として扱い、必要なら確認質問に含める。",
                  ],
                },
              ]
            : []),
          {
            title:
              "初回ヒアリング（issue-body.md がまだ無い場合、または人間差し戻しで新しい論点が必要な場合）",
            content: [
              "既に issue-body.md がある場合、確定済みの事項を蒸し返さない。今回の must 指摘・人間差し戻しに関係する論点だけを確認する。",
              "",
            ],
          },
          {
            title: "from-Issue フローの確認",
            content: [
              "ユーザーに「既存 Issue を取り込みますか？」と確認する。",
              "- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う",
              `- Yes の場合、取得した title / body / labels / state を \`${FROM_ISSUE_KEY}\` としてセッションディレクトリに保存する（レビュアーが取り込み漏れを確認するため）`,
              "- No の場合: 新規計画としてヒアリングを開始する",
            ],
          },
          ...hearingSection,
          {
            title: "ヒアリングの進め方",
            content: [
              "ヒアリングは mt-grill の方式に従って進める:",
              "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
              "- 回答を受けて論点ツリーを更新し、フロンティアを再計算して次のラウンドを提示する",
              "- フロンティアが空になり、ユーザーが共通理解を確認するまでラウンドを継続する",
              "",
            ],
          },
          {
            title: "3. 論点ツリーの最終確認",
            content: [
              "ヒアリングの全決定が論点ツリー上で確定していることを確認する。",
              "初回ヒアリングの質疑ログは別ファイルに残さない。ただしレビュー指摘・人間差し戻しへの決定は review-decisions.md に必ず記録する。",
            ],
          },
        ],
        output: outputLines,
        policy: [
          ...(withDocs
            ? [
                "repo へのファイル書き込み（CONTEXT.md の更新、ADR ファイルの作成、features/ への .feature の作成）は禁止する。確定した用語・ADR 案・Gherkin シナリオ案の issue-body への反映は次段 draft-body で行う。",
              ]
            : []),
          "計画本文（issue-body.md / issue-body-<n>.md）を編集しない。修正は draft-body が行う。",
          "AI が計画の意思決定をしない。ユーザーの回答だけを review-decisions.md に記録する。",
        ],
        input: [
          {
            title: "前回の差し戻し",
            content: hasHumanFeedback
              ? [`- ${REVIEW_GATE_KEY}: ${reviewGateInput!.trim()}`, ""]
              : [
                  `前回の差し戻し (gate:${REVIEW_GATE_KEY}):`,
                  "- (なし。初回実行または前回 approve)",
                  "",
                ],
          },
          ...(retryInput !== undefined && retryInput.trim() !== ""
            ? [`追加ラウンド指示 (gate:${REVIEW_FIX_EXHAUSTED_GATE_KEY}): ${retryInput.trim()}`, ""]
            : []),
          ...(hasFindingsFile ? [`レビュー結果: ${findingsPath}`, ""] : []),
          ...(existsSync(join(ctx.sessionDir, REVIEW_DECISIONS_KEY))
            ? [`ユーザー決定の履歴: ${join(ctx.sessionDir, REVIEW_DECISIONS_KEY)}`, ""]
            : []),
          ...(existsSync(join(ctx.sessionDir, FROM_ISSUE_KEY))
            ? [`元 Issue: ${join(ctx.sessionDir, FROM_ISSUE_KEY)}`, ""]
            : []),
          `セッションディレクトリ: ${ctx.sessionDir}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    const findingsPath = join(ctx.sessionDir, REVIEW_FINDINGS_KEY);
    const hasFindingsFile = existsSync(findingsPath);
    let mustIds: string[] = [];
    if (hasFindingsFile) {
      const findings = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
      const parsed = findings.parsed;
      if (!findings.valid || parsed === undefined) {
        return {
          status: "fail",
          reasons: [
            `review-findings.json を検証できないため grill の完了を確認できません: ${findings.error ?? "invalid findings"}`,
          ],
        };
      }
      mustIds = parsed.findings
        .filter((finding) => finding.severity === "must")
        .map((finding) => finding.id);
      if (mustIds.length > 0) {
        const base = requireStepArtifacts(ctx, [{ key: REVIEW_DECISIONS_KEY, form: "text" }]);
        if (base.status !== "pass") return base;
        const decisions = readSessionFile(ctx.sessionDir, REVIEW_DECISIONS_KEY) ?? "";
        const section = extractMarkdownSection(decisions, `レビュー R${parsed.round}`);
        if (section === undefined) {
          return {
            status: "fail",
            reasons: [
              `${REVIEW_DECISIONS_KEY}: 現在のラウンド（## レビュー R${parsed.round}）の決定セクションがありません`,
            ],
          };
        }
        const missing = mustIds.filter((id) => !hasFindingDecision(section, id));
        if (missing.length > 0) {
          return {
            status: "fail",
            reasons: [
              `${REVIEW_DECISIONS_KEY}: must 指摘（${missing.join(", ")}）に - 決定: adopt|reject|modify と非空の - 内容: が必要です`,
            ],
          };
        }
        return { status: "pass", reasons: [] };
      }
    }

    const reviewGateValue = gateDecisionValue(ctx.gateAnswers, REVIEW_GATE_KEY);
    const reviewGateInput = gateDecisionInput(ctx.gateAnswers, REVIEW_GATE_KEY);
    if (reviewGateValue === "request_changes") {
      if (reviewGateInput === undefined || reviewGateInput.trim() === "") {
        return {
          status: "fail",
          reasons: [
            `${REVIEW_GATE_KEY} の request_changes に追加入力がありません（input required:true の契約違反）`,
          ],
        };
      }
      const base = requireStepArtifacts(ctx, [{ key: REVIEW_DECISIONS_KEY, form: "text" }]);
      if (base.status !== "pass") return base;
      const decisions = readSessionFile(ctx.sessionDir, REVIEW_DECISIONS_KEY) ?? "";
      const section = extractMarkdownSection(decisions, "人間差し戻し");
      if (section === undefined || !hasHumanDecision(section)) {
        return {
          status: "fail",
          reasons: [
            `${REVIEW_DECISIONS_KEY}: 人間差し戻しへの決定（## 人間差し戻し に - 決定: adopt|reject|modify と非空の - 内容:）が必要です`,
          ],
        };
      }
    }
    return { status: "pass", reasons: [] };
  },
};
