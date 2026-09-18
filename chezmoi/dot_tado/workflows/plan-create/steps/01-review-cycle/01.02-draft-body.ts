import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { isTMiura024 } from "../../helper/is-tmiura024.ts";

const GRILL_MAP_KEY = "grill-map.md";
const ISSUE_BODY_KEY = "issue-body.md";
const EFFORT_PATTERN =
  /<!--\s*effort:\s*width=(low|medium|high|xhigh|max)\s+depth=(low|medium|high|xhigh|max)\s*-->/;
const mtDomainModelingDir = join(import.meta.dir, "..", "..", "..", "mt-domain-modeling");
const planFormatPath = join(import.meta.dir, "..", "..", "..", "shared", "plan-plan-format.md");

// -----------------------------------------------------------------
// Step 2: 本文マッピング
// -----------------------------------------------------------------
export const draftBodyStep: TaskStepDef = {
  key: "draft-body",
  phase: "本文マッピング",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const withDocs = isTMiura024(ctx.artifacts, ctx.sessionDir);

      return buildStepPrompt({
        purpose: [
          "ヒアリングで集まった情報を plan-format.md のテンプレートにマッピングし、Issue body の最終本文を確定する。",
          "分解モードの場合は子 Issue の body もすべてこのステップで生成する。",
        ],
        criteria: [
          "Issue body 最終本文が `issue-body.md`（分解時は `issue-body-<n>.md` 全件）に書き出されている",
          "各 body 末尾に `<!-- effort: width=... depth=... -->` コメントが形式どおり付与されている",
        ],
        approach: [
          {
            title: "1. ヒアリング結果の読み込み",
            content: [
              `セッションディレクトリの \`${GRILL_MAP_KEY}\`（ライブ地図）を読み込む。`,
              "from-Issue フローの場合は既存 Issue の内容も合わせて参照する。",
            ],
          },
          ...(withDocs
            ? [
                {
                  title: "2. ドキュメントの整形・埋め込み",
                  content: [
                    `Grill Phase で \`${GRILL_MAP_KEY}\` の \`## 確定用語\` / \`## ADR 案\` セクションに記録された確定用語・ADR 案は確定済みとして扱う。要否の再判断はしない。`,
                    "",
                    "以下を行い、plan-format.md の `## 📄 ドキュメント` セクションに埋め込む:",
                    `- CONTEXT は ${join(mtDomainModelingDir, "CONTEXT-FORMAT.md")} に従い本文を整形する`,
                    `- ADR は ${join(mtDomainModelingDir, "ADR-FORMAT.md")} に従い本文を整形する`,
                    "- ADR 連番は対象 repo の `docs/adr/` を確認して次番号を確定する",
                    "- セクション形式: `### <リポジトリ相対パス>` + コードフェンス全文",
                  ],
                },
              ]
            : []),
          {
            title: "縦切り分解の検討",
            content: [
              "大きな計画を実行可能なミッションへ割る場合は、次を守る:",
              "- 各ミッションは 1 層だけ切らず、必要な層を縦に貫く tracer bullet にする",
              "- 単独で確認できる振る舞いを持つ",
              "- 依存関係は実行順の Wave 配置で表現する（plan-format.md の `### 実行順` 参照）",
            ],
          },
          {
            title: "最終本文の確定",
            content: [
              `plan-format.md（${planFormatPath}）に従い、Issue body の最終本文を確定する。`,
              "単一ミッションの場合も `## 🧩 ミッション` を省略せず、`### 実行順`（`- Wave 1: M1`）と `### M1: <名前>`（スコープ・完了条件付き）を最小形として必ず生成する。単一M1は `## ✅ 完了条件` の全番号をすべて担い、欠番・対象外を残さない（和集合カバー）。",
              `確定した本文をセッションディレクトリに \`${ISSUE_BODY_KEY}\` として書き出す。`,
              "Issue body の末尾には検証強度の推奨を `<!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->` 形式の HTML コメントとして必ず追記する（例: `<!-- effort: width=medium depth=medium -->`）。値は計画の複雑さ・影響範囲から推奨を選び、このコメントを検証強度の決定値の初期値とする（review-gate に width/depth 質問は置かない。変更はファイル直接編集で行う）。既存 Issue（本変更以前に作成されたものでコメントが無いもの）では plan-run の parseEffortFromIssueBody がコメント未検出時に width=medium depth=medium へフォールバックする（既存 Issue 対応）。",
              '生成直後に `grep -E "<!-- effort: width=(low|medium|high|xhigh|max) depth=(low|medium|high|xhigh|max) -->" issue-body.md` で検証し、不一致・欠落があればコメントを追記/修正して再生成する。値は /^[a-z]+$/ の enum のみを許容し、不正値があれば medium に正規化する。',
              "plan-run はこのコメントを parseEffortFromIssueBody で読み取り effort.json 生成に利用するため、コメントの形式は厳守する。",
              "",
              "分解モードの場合:",
              "- 親 Issue の body を `issue-body.md` として書き出す",
              "- 各子計画の body を `issue-body-<n>.md`（n = 1, 2, 3...）として書き出す",
              "- ドキュメントセクション（`## 📄 ドキュメント`）は対応する子計画の body に配置し、親には残さない",
              "- 子計画は 1 階層までとし、再分解しない",
              "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすこと",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める:",
          "```json",
          `{"key": "${ISSUE_BODY_KEY}", "path": "${join(ctx.sessionDir, ISSUE_BODY_KEY)}"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
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
};
