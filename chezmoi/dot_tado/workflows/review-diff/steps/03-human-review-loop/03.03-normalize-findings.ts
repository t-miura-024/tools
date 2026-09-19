import type { ArtifactRecord, CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateFindingsJson } from "../../../shared/review-helpers/validate-findings-json";
import { parseJson } from "../../../shared/review-helpers/parse-json";
import { isRecord } from "../../../shared/review-helpers/is-record";
import { validateEffort } from "../../../shared/review-helpers/validate-effort";
import { parseDiffChangedLines } from "../../../shared/review-helpers/parse-diff-changed-lines";
import { listUntrackedFiles } from "../../../shared/review-helpers/list-untracked-files";
import { auditFindingsNormalization } from "../../../shared/review-helpers/audit-findings-normalization";
import { buildDifitComments } from "../../../shared/review-helpers/build-difit-comments";
import { diffDifitComments } from "../../../shared/review-helpers/diff-difit-comments";
import { EFFORT_KEY } from "../../../shared/review-helpers/effort-key";
import { FINDINGS_KEY } from "../../../shared/review-helpers/findings-key";
import { DIFIT_COMMENTS_KEY } from "../../../shared/review-helpers/difit-comments-key";
import { resolveEffortTarget } from "../../helper/resolve-effort-target.ts";
export const normalizeFindingsStep: TaskStepDef = {
  key: "normalize-findings",
  phase: "findings 正規化",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const findingsPath = join(ctx.sessionDir, FINDINGS_KEY);
      const difitCommentsPath = join(ctx.sessionDir, DIFIT_COMMENTS_KEY);
      const effortPath = join(ctx.sessionDir, EFFORT_KEY);
      const reviewerOutputsPath = join(ctx.sessionDir, "reviewer-outputs.json");

      return [
        "## 目的",
        "",
        "検証者の生 findings を集約し、機械ルールで正規化する。difit セッションには触らない（注入は後段の start-difit-review が担当）。",
        "",
        "## 入力",
        "",
        `- reviewer-outputs.json (${reviewerOutputsPath}): run-reviewers が集約した生 findings (各 reviewer の JSON を結合した配列)`,
        `- effort.json (${effortPath}): width/depth/round`,
        `- diff.txt: 対象差分 (位置補正の参照用)`,
        "",
        "## 手順",
        "",
        "1. 生 findings を読み込み、以下の機械ルールで正規化する (純粋関数として実装 — LLM の恣意的な再解釈は禁止):",
        "   - 各 finding の axis が PERSPECTIVE_POOL の 15 観点に含まれるか検証 (未知 axis は除外し reasons に記録)",
        "   - severity が must/should/want のいずれかであることを検証",
        '   - filePath が必須、position が必須（side:"new"、line は正の整数）であることを検証（missing / old_side は除外し filteredOut に記録）',
        "   - diff.txt を parseDiffChangedLines でパースし `Map<filePath, Set<addedLines>>` を生成する（+++ b/<path> と @@ 見出しの new側カウントで `+` 行を抽出。削除ファイル/bynary/ /dev/null はスキップ）",
        "   - filterFindingsByDiff で diff外ファイル / `+` 行でない line / missing_position / old_side を機械的に除外し `filteredOut: {count, items:[{axis,filePath,line,reason}]}` に記録する（reason: file_not_in_diff / line_not_in_added / missing_position / old_side / missing_filePath）",
        "   - 同一ファイルで ±2 行以内の findings はマージする (mergeFindingsByProximity 純粋関数。detail 連結、severity は must>should>want の最優先を継承、suggestions 結合)",
        "   - 除外後の kept について counts.must/should/want を再計算し、counts が厳密に一致することを検証",
        "",
        `2. 正規化した findings を findings.json (${findingsPath}) として書き出す。スキーマ:`,
        "```json",
        '{ "round": 1, "width": "medium", "depth": "medium", "findings": [{"axis":"req-1","severity":"must","detail":"...","filePath":"src/a.ts","position":{"side":"new","line":10}}], "counts":{"must":1,"should":0,"want":0}, "filteredOut":{"count":2,"items":[{"axis":"req-1","filePath":"src/b.ts","line":5,"reason":"line_not_in_added"}]}, "coverage":{"reviewers":[{"index":1,"perspectives":["req-1"]}],"diffFiles":["src/a.ts"],"diffAddedLines":10} }',
        "```",
        "   - round は effort.json の round (なければ 1)",
        "   - width/depth は effort.json の値を継承",
        "   - filteredOut は任意。除外があった場合のみ count と items（axis/filePath/line/reason/detail）を記録し、人間へ透明に通知する",
        "   - coverage は必須（ゼロ結果を「未検出」として透明化するための実施範囲の記録）。effort.json の width/depth から導出した検証者番号と担当観点 ID 一覧（reviewers）、diff.txt の `+++ b/<path>` から列挙した検証対象ファイル一覧（diffFiles、ソート済み）、`+` 行総数（diffAddedLines）を記録する。判定には使わない（record-only）が、省略しないこと。",
        "",
        `3. findings.json を difit comment import 形式へ変換し、GFM Markdown のコメント本文を生成する (純粋関数 formatReviewComment / buildDifitComments):`,
        "   - severity: 🚨 must / ⚠️ should / 💡 want、taxonomy: 🐛 issue (must) / 🙋 question (should/want)",
        "   - axis: 15 観点の絵文字 (🎯 req-1 / 📋 req-2 / 🛡️ logic-1 / 🔒 logic-2 / 🧭 logic-3 / ⚡ logic-4 / 👁️ ai-1 / 🔌 ai-2 / ♻️ ai-3 / 🩹 ai-4 / 🧩 arch-1 / 🧱 arch-2 / 🎨 arch-3 / 🏷️ arch-4 / 🔗 arch-5)",
        "   - body は GFM Markdown: 1 行目 `**🚨 must · 🐛 issue · 🎯 req-1**`（severity / taxonomy / axis を絵文字で区別。mt difit check の taxonomy 分類が認識する契約）、`**対象**: filePath:line`、`**詳細**:`、任意で `**提案**:` の箇条書き",
        '   - 各エントリは `{"type":"thread","filePath":...,"position":{"side":"new","line":...},"body":...}`。filePath はリポジトリルートからの相対パスで必須、position は side:"new" のみ（旧形式の [] プレフィックスや独自 markup は生成しない）',
        '   - diff-only 規律: filePath なし / position なし / side:old / line 不正は convert 時に機械的に除外され、difit には注入されない（buildDifitComments は position 必須。position なしエントリの `{"side":"new","line":1}` 合成は行わない）',
        "",
        `   変換結果を ${difitCommentsPath} に JSON 配列として保存する (空配列でも保存する)。buildDifitComments 純粋関数を参照。`,
        "",
        "4. report 時の artifacts に以下を含める:",
        "```json",
        `[{"key":"${FINDINGS_KEY}","path":"${findingsPath}"},{"key":"${DIFIT_COMMENTS_KEY}","path":"${difitCommentsPath}"}]`,
        "```",
        "",
        "## 制約",
        "",
        "- findings.json のスキーマ検証を必ず行う (validateFindingsJson — filePath必須/position必須/side:new を検証)",
        "- ±2 行マージは純粋関数で決定論的に行う (LLM の判断でマージしない)",
        "- diffフィルタは純粋関数 parseDiffChangedLines + filterFindingsByDiff で決定論的に行い、counts を再計算して filteredOut に透明に記録する",
        "- GFM Markdown の body を生成し、severity/taxonomy を継承する (must→issue, should/want→question)。taxonomy 絵文字は Rust 側の分類契約",
        "- difit セッションに触れない（起動と注入は start-difit-review が担当）。workflow.db のループ制御に触れない",
        "",
        "## セッション情報",
        "",
        `- セッションディレクトリ: ${ctx.sessionDir}`,
      ].join("\n");
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.attemptResult.status !== "completed") {
      return {
        status: "error",
        reasons: [ctx.attemptResult.errors ?? "normalize-findings failed"],
      };
    }
    const raw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], FINDINGS_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, FINDINGS_KEY);
    const result = validateFindingsJson(raw);
    if (!result.valid) {
      return { status: "error", reasons: [result.error ?? "findings validation failed"] };
    }
    // effort の round を findings が引き継ぐことを機械検証する。
    const effortRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, EFFORT_KEY);
    const effort = parseJson(effortRaw);
    if (isRecord(effort)) {
      const effortValidation = validateEffort(effort, { allowRoundOverflow: true });
      if (effortValidation.status !== "pass") {
        return {
          status: "fail",
          reasons: [
            `effort.json の round 契約が不正です: ${effortValidation.reasons.join(" / ")}。findings.json の round 照合をできないため fail とします`,
          ],
        };
      }
      if (result.parsed!.round !== effortValidation.round) {
        return {
          status: "fail",
          reasons: [
            `findings.json の round=${result.parsed!.round} が effort.json の round=${effortValidation.round} と不一致です。round は effort.json から継承してください`,
          ],
        };
      }
    }
    // 差分限定の機械的検証 — findings の全指摘が diff.txt の `+` 行に含まれることを検証
    const diffRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], "diff.txt", ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, "diff.txt");
    // 解析済み Map は正規化監査（auditFindingsNormalization）にも渡し、
    // 大規模 diff.txt の二重パースを避ける（同一のパース結果で両検証を行う）。
    const changedLinesMap = diffRaw === undefined ? undefined : parseDiffChangedLines(diffRaw);
    if (changedLinesMap) {
      for (const f of result.parsed!.findings) {
        if (f.filePath === undefined || f.position === undefined) {
          return {
            status: "fail",
            reasons: [
              `finding is missing filePath or position (filePath and position.side:"new" with line are required). parseDiffChangedLines/filterFindingsByDiff で機械的に除外してください`,
            ],
          };
        }
        const set = changedLinesMap.get(f.filePath);
        if (!set) {
          return {
            status: "fail",
            reasons: [
              `finding at ${f.filePath}:${f.position.line} is not in diff (file_not_in_diff). diff.txt の \`+\` 行のみが指摘対象です。parseDiffChangedLines/filterFindingsByDiff で機械的に除外してください`,
            ],
          };
        }
        if (!set.has(f.position.line)) {
          return {
            status: "fail",
            reasons: [
              `finding at ${f.filePath}:${f.position.line} is not in diff added lines (line_not_in_added). diff.txt の \`+\` 行のみが指摘対象です。parseDiffChangedLines/filterFindingsByDiff で機械的に除外してください`,
            ],
          };
        }
      }
    }
    // reviewer-outputs.json → findings.json の正規化対応を機械照合する。
    // 正規化は「基本検証 → diff フィルタ → ±2 マージ」の純粋関数パイプラインであり、
    // 集約段で must / should を黙って落とすと counts が自己整合していても提示から
    // 漏れる。ここで生 findings 総数を kept + filteredOut + 例外除外 + merge統合 に
    // 突合し、欠落・余剰・filteredOut の改変を fail にする。
    const reviewerOutputsRaw =
      findArtifactText(
        ctx.artifacts as ArtifactRecord[],
        "reviewer-outputs.json",
        ctx.sessionDir,
      ) ?? readSessionFile(ctx.sessionDir, "reviewer-outputs.json");
    let rawFindings: unknown;
    try {
      rawFindings = reviewerOutputsRaw === undefined ? undefined : JSON.parse(reviewerOutputsRaw);
    } catch {
      rawFindings = undefined;
    }
    // diff.txt の完全性の期待値（untracked 一覧）は git から機械導出し、audit に渡す。
    // 不完全な diff.txt を SoT として通過させない（欠落ファイルの must が
    // file_not_in_diff へ落ちても監査が検出する）。target ありでは collect-context が
    // untracked を diff.txt に含めない（提示範囲 base...target のみが SoT）ため、
    // untracked の欠落検査は行わず truncate マーカー検査だけを audit に委ねる。
    const targetScope = resolveEffortTarget(ctx);
    let untrackedFiles: readonly string[] = [];
    if (!targetScope) {
      const untracked = listUntrackedFiles();
      if ("error" in untracked) {
        return {
          status: "fail",
          reasons: [
            `diff.txt の完全性を検証できません: ${untracked.error}。untracked の取りこぼしを検出できないため fail とします`,
          ],
        };
      }
      untrackedFiles = untracked.files;
    }
    const normalizationAudit = auditFindingsNormalization(rawFindings, diffRaw, result.parsed!, {
      changedLinesMap,
      untrackedFiles,
    });
    if (!normalizationAudit.match) {
      return {
        status: "fail",
        reasons: [
          "findings.json が reviewer-outputs.json（生 findings）からの正規化と一致しません。集約段で must / should が提示から漏れています。基本検証 → filterFindingsByDiff → mergeFindingsByProximity の機械導出をやり直してください",
          ...normalizationAudit.reasons,
        ],
      };
    }
    // findings.json → difit-comments.json の機械導出を検証する（logic-2: 循環検証の遮断）。
    // start-difit-review の check は「difit-comments.json がサーバ上に存在するか」しか
    // 見ないため、orchestrator が findings の部分集合を書いても全 check が green に
    // なり得る。ここで buildDifitComments（純粋関数）の期待出力と完全一致を要求し、
    // 欠落・改変・余剰を注入前に fail にする。
    const commentsRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], DIFIT_COMMENTS_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, DIFIT_COMMENTS_KEY);
    const actualComments = commentsRaw === undefined ? undefined : parseJson(commentsRaw);
    if (!Array.isArray(actualComments)) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_COMMENTS_KEY} must be a JSON array generated by buildDifitComments(findings.json)`,
        ],
      };
    }
    const commentsDiff = diffDifitComments(buildDifitComments(raw), actualComments);
    if (!commentsDiff.match) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_COMMENTS_KEY} が findings.json から buildDifitComments で機械導出した内容と一致しません。欠落 ${commentsDiff.missing.length} 件: ${commentsDiff.missing.join(" / ") || "なし"}、余剰 ${commentsDiff.unexpected.length} 件: ${commentsDiff.unexpected.join(" / ") || "なし"}、キー生成不能 ${commentsDiff.invalid.length} 件: ${commentsDiff.invalid.join(" / ") || "なし"}。findings の指摘（filteredOut を除く）を変換せず注入すると、blocking な指摘が人間に提示されないままゲートを通過します`,
        ],
      };
    }
    return {
      status: "pass",
      reasons: [
        `findings: round=${result.parsed!.round} must=${result.parsed!.counts.must} should=${result.parsed!.counts.should} want=${result.parsed!.counts.want} (difit-comments derived check ok)`,
      ],
    };
  },
};
