import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { isTMiura024 } from "../../helper/is-tmiura024.ts";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";

const mtGrillDir = join(import.meta.dir, "..", "..", "..", "mt-grill");
const mtDomainModelingDir = join(import.meta.dir, "..", "..", "..", "mt-domain-modeling");

// ---------------------------------------------------------------------------
// Loop (human gate revise 置換) の説明は steps/01-review-cycle/index.ts を参照。
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------
// Step 1: Grill Phase
// -----------------------------------------------------------------
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

      const hearingSection = withDocs
        ? [
            {
              title: "2. 徹底ヒアリング + ドメインモデリング",
              content: [
                `mt-grill スキル（${join(mtGrillDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                "",
                `加えて mt-domain-modeling スキル（${join(mtDomainModelingDir, "SKILL.md")}）を参照し、その規律をすべて適用する。`,
                "",
                "確定した用語・ADR 案は次段 draft-body で `## 📄 ドキュメント` に埋め込む前提で確定させること。",
                `フォーマットは ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} / ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従う。`,
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

      return buildStepPrompt({
        purpose: [
          "計画の全側面についてユーザーと共通理解に達するまでヒアリングを行う（Grill Phase）。",
        ],
        criteria: [
          "フロンティア（前提がすべて確定済みの決定）が空になり、ユーザーが共通理解を確認した",
        ],
        approach: [
          {
            title: "1. from-Issue フローの確認",
            content: [
              "ユーザーに「既存 Issue を取り込みますか？」と確認する。",
              "- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う",
              "- No の場合: 新規計画としてヒアリングを開始する",
            ],
          },
          ...hearingSection,
          "ヒアリングは mt-grill の方式に従って進める:",
          "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
          "- 回答を受けて論点ツリーを更新し、フロンティアを再計算して次のラウンドを提示する",
          "- フロンティアが空になり、ユーザーが共通理解を確認するまでラウンドを継続する",
          "",
          {
            title: "3. 論点ツリーの最終確認",
            content: [
              `ヒアリングの全決定が論点ツリー上で確定していることを確認する。`,
              "質疑ログなどの別ファイルは残さない。",
            ],
          },
        ],
        output: [
          "成果物なし。中間ファイルは残さない。確定内容は次段 draft-body で `issue-body.md` に集約する。",
        ],
        policy: withDocs
          ? [
              "repo へのファイル書き込み（CONTEXT.md の更新、ADR ファイルの作成）は禁止する。確定した用語・ADR 案の issue-body への反映は次段 draft-body で行う。",
            ]
          : [],
        input: [
          {
            title: "前回の差し戻し",
            content: (() => {
              const gateKey = "review-gate";
              const value = gateDecisionValue(ctx.gateAnswers, gateKey);
              const input = gateDecisionInput(ctx.gateAnswers, gateKey);
              if (value === "request_changes" && input !== undefined && input.trim() !== "") {
                return [
                  `前回の差し戻し (gate:${gateKey}。loop 再実行時はこの指摘を反映する):`,
                  `- ${gateKey}: ${input.trim()}`,
                  "",
                ];
              }
              return [`前回の差し戻し (gate:${gateKey}):`, "- (なし。初回実行)", ""];
            })(),
          },
          `セッションディレクトリ: ${ctx.sessionDir}`,
        ],
      });
    },
  },
  // 成果物なし。完了のみ確認する。
  check: (_ctx: CheckCtx): CheckResult => {
    return { status: "pass", reasons: [] };
  },
};
