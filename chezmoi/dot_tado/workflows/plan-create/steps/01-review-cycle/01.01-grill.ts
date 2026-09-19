import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { isTMiura024 } from "../../helper/is-tmiura024.ts";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";

const GRILL_MAP_KEY = "grill-map.md";
const mtGrillRoundsDir = join(import.meta.dir, "..", "..", "..", "mt-grill-rounds");
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
      const grillMapPath = join(ctx.sessionDir, GRILL_MAP_KEY);

      const hearingSection = withDocs
        ? [
            {
              title: "2. 徹底ヒアリング + ドメインモデリング",
              content: [
                `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
                "",
                `加えて mt-domain-modeling スキル（${join(mtDomainModelingDir, "SKILL.md")}）を参照し、その規律をすべて適用する。`,
                "",
                "確定した用語・ADR 案はすべてライブ地図の `## 確定用語` / `## ADR 案` セクションに記録すること。",
                `フォーマットは ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} / ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従う。`,
              ],
            },
          ]
        : [
            {
              title: "2. 徹底ヒアリング",
              content: [
                `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
              ],
            },
          ];

      return buildStepPrompt({
        purpose: [
          "計画の全側面についてユーザーと共通認識に達するまでヒアリングを行う（Grill Phase）。",
        ],
        criteria: [
          "フロンティア（前提がすべて確定済みの決定）が空になり、ユーザーが共通認識を確認した",
          "全決定がライブ地図 `grill-map.md` に `[確定]` として蒸留されている（check が実在・非空を検証）",
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
          "ヒアリングは mt-grill-rounds の方式に従って進める:",
          `- ライブ地図のパスは既定パスではなく \`${grillMapPath}\`（セッションディレクトリ配下）を明示的に指定し、このパスで地図を育成する`,
          "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
          "- 回答をライブ地図へ反映した後にフロンティアを再計算し、次のラウンドを提示する",
          "- フロンティアが空になり、ユーザーが共通認識を確認するまでラウンドを継続する",
          "",
          {
            title: "3. ライブ地図の最終確認",
            content: [
              `ヒアリングの全決定がセッションディレクトリのライブ地図 \`${grillMapPath}\` に蒸留されていることを確認する。`,
              "地図は Markdown 入れ子リスト＋状態マーカー（`[確定]` / `[未決]` / `[保留]`）の単一ファイルとし、質疑ログなどの別ファイルは残さない。",
              ...(withDocs
                ? [
                    "ドメインモデリングで確定した用語・ADR 案が `## 確定用語` / `## ADR 案` セクションに記録されていることも確認する。",
                  ]
                : []),
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める:",
          "```json",
          `{"key": "${GRILL_MAP_KEY}", "path": "${grillMapPath}"}`,
          "```",
        ],
        policy: withDocs
          ? [
              "repo へのファイル書き込み（CONTEXT.md の更新、ADR ファイルの作成）は禁止する。確定した用語・ADR 案はライブ地図の `## 確定用語` / `## ADR 案` セクションへの記録に留めること",
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
  // 統一最低ライン: ライブ地図の申告・実在・非空を強制する。
  // 地図の構造（見出し・セクション）は mt-grill-rounds が適応的に決めるため固定しない。
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [{ key: GRILL_MAP_KEY, form: "markdown" }]);
  },
};
