import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { buildStepPrompt } from "../../../../shared/prompt/build-step-prompt";
import { VALID_WIDTHS } from "../../../../shared/review-helpers/valid-widths";
import { VALID_DEPTHS } from "../../../../shared/review-helpers/valid-depths";
import { EFFORT_KEY as REVIEW_EFFORT_KEY } from "../../../../shared/review-helpers/effort-key";
import { effortFromIssueBody } from "../../../../shared/collect-plan-review-context/effort-from-issue-body";
import { resolveEffortStep } from "../../../../review-diff/steps/01-effort-loop/01.01-resolve-effort.ts";

// -------------------------------------------------------------------
// Step 4: 検証強度解決（human_gate 廃止 — Issue body コメント or medium/medium の自動解決）
//         SoT は plan-create の Issue body 末尾 `<!-- effort: ... -->` のみ。
//         プロンプト記法 width=... depth=... による上書きは受理しない。
// -------------------------------------------------------------------
export const resolveEffortPlanStep: TaskStepDef = {
  key: "resolve-effort",
  phase: "検証強度解決",
  type: "task",
  maxRetries: 1,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: ["Issue body の effort コメントから検証強度を解決する。人手選択は行わない。"],
        criteria: [],
        approach: [
          "1. セッションディレクトリの issue-body.md（または artifacts の issue-body.md）を読み、末尾の `<!-- effort: width=... depth=... -->` を確認する",
          "2. コメントがあればその width/depth を報告する。なければ width=medium depth=medium を適用する旨を報告する",
          "3. プロンプト記法 `width=... depth=...` による上書きは無視する",
          "4. effort.json の生成は行わない（生成は run-reviewers.beforeStep が担う）。check は純粋判定のみ",
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    // effort.json が既にあれば review-diff の SoT check に委譲（純粋検証のみ）
    const origCheck = resolveEffortStep.check;
    const existingRaw =
      findArtifactText(ctx.artifacts, REVIEW_EFFORT_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, REVIEW_EFFORT_KEY);
    if (existingRaw) {
      return origCheck(ctx);
    }
    // effort.json がない場合、Issue body の HTML コメントのみで判定する
    // SoT は plan-create の finalize が書く末尾 HTML コメントのみ:
    // `<!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->`
    // プロンプト記法 (width=... のばら撒き) や `width: ...` セクション記法は受理しない。
    const issueBody = (() => {
      try {
        const t = findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
        if (t) return t;
      } catch {}
      return readSessionFile(ctx.sessionDir, "issue-body.md");
    })();
    // コメントらしきものがあるが厳密な width+depth を満たさない場合は不正として止める。
    // 欠落（コメントなし）と区別し、不正時は medium 化しない。
    const hasInvalidEffortComment = (() => {
      const body = issueBody;
      if (!body) return false;
      const blocks = [...body.matchAll(/<!--\s*effort:.*?-->/gis)].map((m) => m[0]);
      if (blocks.length === 0) return false;
      try {
        effortFromIssueBody(body);
        return false;
      } catch {
        return true;
      }
    })();
    if (hasInvalidEffortComment) {
      return {
        status: "fail",
        reasons: [
          "Issue body の effort コメントが不正です。plan-create で修正して再実行してください（形式: <!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->）",
        ],
      };
    }
    const derived = (() => {
      const issueBodyForEffort = (() => {
        try {
          const t = findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
          if (t) return t;
        } catch {}
        return (
          readSessionFile(ctx.sessionDir, "issue-body.md") ??
          readSessionFile(ctx.sessionDir, "issue-body.txt")
        );
      })();
      const body = issueBodyForEffort;
      const effort =
        !body || !/<!--\s*effort:/i.test(body)
          ? ({} as { width?: string; depth?: string })
          : effortFromIssueBody(body);
      if (effort.width && effort.depth) {
        // check は純粋判定が契約のためファイル生成は行わない (生成は run-reviewers.beforeStep の task 側で実施)
        return { width: effort.width, depth: effort.depth };
      }
      return undefined;
    })();
    if (derived) {
      if (!VALID_WIDTHS.has(derived.width) || !VALID_DEPTHS.has(derived.depth)) {
        return {
          status: "fail",
          reasons: [
            "Issue body の effort コメントが不正です。plan-create で修正して再実行してください（形式: <!-- effort: width=<low|medium|high|xhigh|max> depth=<low|medium|high|xhigh|max> -->）",
          ],
        };
      }
      return {
        status: "pass",
        reasons: [`effort derived from issue body: width=${derived.width} depth=${derived.depth}`],
      };
    }
    return {
      status: "pass",
      reasons: [
        "effort not specified — will be generated with medium/medium in run-reviewers.beforeStep",
      ],
    };
  },
};
