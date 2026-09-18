import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { join } from "node:path";
import { findArtifactText } from "tado/artifacts";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";
import { verifyIssueOpen } from "../../shared/gh-issue-verify/verify-issue-open";
import { requireChildReviewIfChildrenExist } from "../helper/require-child-review-if-children-exist.ts";
import { isLoopExhausted } from "../helper/is-loop-exhausted.ts";

const PREPARE_DECISION_KEY = "prepare-decision.json";
const ISSUE_BODY_KEY = "issue-body.md";
const REVIEW_BODY_KEY = "review-body.md";
const ISSUE_NUMBER_KEY = "issue-number.txt";
const REVIEW_EXHAUSTED_GATE_KEY = "review-exhausted";
const REVIEW_CYCLE_LOOP_KEY = "review-cycle";
const REVIEW_CYCLE_EXHAUSTED_KEY = "review-cycle-exhausted.json";
// review-body.md 内の must 残存マーカー。全角英数・全角スペース・漢数字を半角正規化後に判定する。
// 🚨 の存在（直後に なし/無し/ナシ/ゼロ/0 が続く否定文を除く）は全文を対象に残存とみなす。
// `must` と 1 以上の数値の組み合わせは概要セクション（## レビュー結果〜## 指摘一覧の手前）のみを
// 判定対象とする。本文中の通常英文・コード片の must+数字を残存扱いにしないため。
// （`must 0` / `指摘なし` は残存とみなさない）。
// 件数申告の正規形（概要の must n / should n / want n）は厳密パースして数値>0でfailにする。
const MUST_RESIDUAL_PATTERNS = [/🚨/, /\bm\s*u\s*s\s*t\W*[1-9]/i];

const planTransitionPlanPath = join(
  import.meta.dir,
  "..",
  "..",
  "shared",
  "plan-transition-plan",
  "main.ts",
);

// -----------------------------------------------------------------
// Step 6: Refined Issue 作成
// -----------------------------------------------------------------
export const createRefinedStep: TaskStepDef = {
  key: "create-refined",
  phase: "Refined Issue 作成",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "review-gate で承認された Issue body を使って Refined Issue を直接作成（または更新）する。",
          "コンテンツ生成は行わず、effort コメント確定と GitHub 操作のみに専念する。",
          "承認前の作成はしない（本ステップは review-gate 通過後のみ実行される）。",
        ],
        criteria: [
          "承認済み body で Refined Issue の作成（または更新）が完了し、番号が `issue-number.txt`（子は `issue-number-<n>.txt`）に記録されている",
          "Project への追加と refined 遷移が完了している",
        ],
        approach: [
          {
            title: "1. 入力情報の読み込み",
            content: [
              "分解モードで子 body（`issue-body-<n>.md`）が存在するのに `review-body.md` に子への言及（`issue-body-<n>.md` の記載）がない場合は子未レビューのため GitHub 操作へ進むな。escalate し、失敗報告のみ行うこと。",
              `セッションディレクトリの \`${ISSUE_BODY_KEY}\` と \`${PREPARE_DECISION_KEY}\` と \`${REVIEW_BODY_KEY}\` を読み込む。`,
              "分解モードの場合は `issue-body-<n>.md` も `ls issue-body-*.md` で全件検出して読み込む。",
              "prepare-decision.json から mode / fromIssue / issueNumber / repo を確認する。",
              "review-body.md の 🚨 must 有無を確認する。must が残るまま本ステップに到達した場合は判断漏れのため GitHub 操作へ進まず escalate する（create-refined の check が must 残存で fail し onFail escalate となる。tado 上で review-gate の request_changes を選び grill に戻って再生成すること）。ただし review-cycle-exhausted.json の valid マーカーがある枯渇経由（review-exhausted の approve）の場合は警告として記録し作成へ進む（check が警告付きで後続へ進む）。body の再生成はしない（修正は request_changes→grill 経由の再生成に一本化）。",
            ],
          },
          {
            title: "2. effort コメントの確定",
            content: [
              "各ファイル末尾の `<!-- effort: width=... depth=... -->` コメント（draft-body が書き出した初期値を決定値とする）を維持し、形式検証のみ行う。各ファイルで既存 `<!-- effort:.*?-->` を `/<!-- effort:.*?-->/` で置換せず、そのまま残す。コメントが欠落している場合のみ末尾に追記する（冪等）。分解モードでは `ls issue-body-*.md 2>/dev/null` で全件検出し各ファイルで同様に確認する。新規作成フローでは Issue 作成前のため `gh issue edit` は不要だが、from-Issue フロー・リトライ更新パスでは後段 §3 の `gh issue edit` で effort 反映済み body を更新すること。",
              'このコメントは plan-run の parseEffortFromIssueBody が読み取るため形式は厳守する。更新後は `grep -E "<!-- effort: width=(low|medium|high|xhigh|max) depth=(low|medium|high|xhigh|max) -->" issue-body.md`（分解モードでは `issue-body-*.md` の各件も対象にして）で検証する。不一致・欠落があればコメントを修正して再検証するループを繰り返し、それでも一致しなければ escalate して GitHub 作成へ進まない（失敗報告し、作成コマンドを実行しない）。',
            ],
          },
          {
            title: "3. Refined Issue の作成または更新",
            content: [
              `セッションディレクトリに issue-number.txt が存在する場合（リトライ時）は、既存 Issue を \`gh issue edit\` で更新し、新規作成はしない（冪等ガード）。`,
              "存在しない場合は新規作成する。",
              "分解モードで子 Issue の作成まで進んで失敗した場合は、作成済みの子は再作成せず既存番号を使い、未作成の子のみ作成する。部分失敗時の再実行は issue-number.txt を起点に本ステップから再開する（finalize から再開しない）。",
              "",
              '**番号検証（必須）:** `gh issue edit` / `plan-transition-plan.ts` に渡す番号は、必ずセッションディレクトリ内の `issue-number.txt` と `issue-number-<n>.txt` の全件から読み取った値のみ使う。LLM が記憶・推測した番号を直接埋め込まない。使う前に全件の数字形式を検証し（例: `for f in ${ctx.sessionDir}/issue-number.txt ${ctx.sessionDir}/issue-number-*.txt; do [ -f "$f" ] || continue; grep -Eq \'^[0-9]+$\' "$f" || echo "NG: $f"; done`）、1件でも不一致・空・欠落があれば GitHub 操作へ進まず escalate する。シェルに渡すパスはセッションディレクトリ配下の絶対パスで指定し、クォートする。',
              "",
              {
                title: "3a. from-Issue フロー（既存 Issue を更新）",
                content: [
                  "```bash",
                  `gh issue edit <number> --body-file ${ctx.sessionDir}/issue-body.md`,
                  "```",
                  "",
                  "**重要:** 新規作成せず、必ず既存 Issue を更新すること。",
                  "",
                ],
              },
              {
                title: "3b. 新規作成フロー（mode: update）",
                content: [
                  "```bash",
                  `gh issue create --title "<title>" --body-file ${ctx.sessionDir}/issue-body.md --label "kind/plan"`,
                  "```",
                  "",
                ],
              },
              {
                title: "3c. 分解モード（mode: decompose）",
                content: [
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
                ],
              },
            ],
          },
          {
            title: "4. Project への追加と refined 化",
            content: [
              "Issue（分解モードの場合は親子すべて）を GitHub Project に追加する:",
              "",
              "```bash",
              "gh project item-add <project-number> --owner <owner> --url <issue-url>",
              "```",
              "",
              "続けて refined に遷移する（Status 更新 + `## 🐢 履歴` へ遷移エントリ追記）。`<number>` には §3 の番号検証を通過した `issue-number.txt` と `issue-number-<n>.txt` の全件の値のみ使う（未検証の番号を渡さない）:",
              "",
              "```bash",
              `bun run ${planTransitionPlanPath} <number> refined`,
              "```",
              "",
              "分解モードの場合は子 Issue すべてと親 Issue について実行し、親子すべてを refined にする。",
            ],
          },
          {
            title: "5. Issue 番号の記録",
            content: [
              "§3 で Issue を1件作成するごとに直ちに `issue-number.txt`（子は `issue-number-<n>.txt`）へ記録し、§4 に進む前に全件の記録を完了する（作成と記録の間隔を空けず、再実行時の重複作成を防ぐ）。",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める:",
          "```json",
          `{"key": "issue-number.txt", "path": "${ctx.sessionDir}/issue-number.txt"}`,
          "```",
        ],
        policy: [
          "未レビュー子の refined 化を禁止する。分解モードで子 body が存在するのに review-body.md に子への言及（`issue-body-<n>.md` の記載）がない場合は子未レビューのため GitHub 操作を行うな。escalate し、失敗報告のみ行うこと",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    // review-body.md を必須化する（未申告・欠落時は GitHub 照合の前に fail）。
    // must 残存時の approve 抑止は review-gate が human_gate のため機械化できず、
    // 人間が誤って approve した場合の最終防壁としてここで must 否定検査を行う（fail-closed）。
    // ただし枯渇経由（review-cycle-exhausted.json の valid マーカーあり＋
    // review-exhausted の approve）の場合はゲートの約束どおり未反映のまま
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
    // must 残存の二重照合: 概要セクション（## レビュー結果〜## 指摘一覧の手前）の
    // 厳密パース（数値>0で残存）と概要内 must+数値パターンのいずれかで残存とみなす。
    // 🚨 は全文を対象に、否定直後（なし/無し/ナシ/ゼロ/0）を除いて残存とみなす。
    const hasMustResidual = (() => {
      const text = reviewBody;
      const start = text.indexOf("## レビュー結果");
      const end = start === -1 ? -1 : text.indexOf("## 指摘一覧", start);
      const summary = start === -1 ? text : end === -1 ? text.slice(start) : text.slice(start, end);
      const normalizedSummary = normalizeMustText(summary);
      const declaredMatch = normalizedSummary.match(/\bm\s*u\s*s\s*t\W*([0-9]+)/i);
      const declared = declaredMatch ? Number.parseInt(declaredMatch[1], 10) : null;
      if (declared !== null && declared > 0) return true;
      const normalizedFull = normalizeMustText(text);
      const withoutNegatedEmoji = normalizedFull.replace(/🚨\s*(なし|無し|ナシ|ゼロ|0)\s*/g, "");
      if (MUST_RESIDUAL_PATTERNS[0].test(withoutNegatedEmoji)) return true;
      if (MUST_RESIDUAL_PATTERNS[1].test(normalizedSummary)) return true;
      return false;
    })();
    if (hasMustResidual) {
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
};

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
