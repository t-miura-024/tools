import type { WorkflowDef, StepDef, CheckCtx, PromptCtx, CheckResult, ArtifactRecord } from "tado";
import { join } from "node:path";
import fs from "node:fs";
import {
  shellQuote,
  WIDTH_TO_COUNT,
  DEPTH_TO_PER_COUNT,
  getPerspectivesForWidth,
  getReviewerAssignments,
  getReviewerWaves,
  validateFindingsJson,
  validateVerdictJson,
  findArtifactText,
  readSessionFile,
  findJsonObject,
  parseJson,
  isRecord,
  parseDiffChangedLines,
  parseHunkCheck,
  runHunkCommand,
  isHunkSessionActive,
  validateEffortBaseTarget,
  HUNK_START_KEY,
  HUNK_COMMENTS_KEY,
  HUNK_CHECK_KEY,
  EFFORT_KEY,
  FINDINGS_KEY,
  VERDICT_KEY,
  VALID_WIDTHS,
  VALID_DEPTHS,
} from "../_shared/mt-review-helpers.ts";
import type { Width, Depth } from "../_shared/mt-review-helpers.ts";

// Re-export pure helpers for backward compatibility (mt-plan-run, tests)
export {
  PERSPECTIVE_POOL,
  WIDTH_ORDER,
  DEPTH_ORDER,
  WIDTH_TO_COUNT,
  DEPTH_TO_PER_COUNT,
  getPerspectivesForWidth,
  getPerReviewerCount,
  getReviewerAssignments,
  getReviewerWaves,
  getReviewerCount,
  parseEffortArgs,
  validateFindingsJson,
  validateVerdictJson,
  mergeFindingsByProximity,
  parseDiffChangedLines,
  filterFindingsByDiff,
  formatReviewComment,
  buildHunkComments,
  findArtifactText,
  readSessionFile,
  findJsonObject,
  parseJson,
  parseHunkCheck,
  runHunkCommand,
  isHunkSessionActive,
  isPathInside,
  shellQuote,
  isValidGitRefName,
  validateEffortBaseTarget,
  HUNK_START_KEY,
  HUNK_COMMENTS_KEY,
  HUNK_CHECK_KEY,
  EFFORT_KEY,
  FINDINGS_KEY,
  VERDICT_KEY,
} from "../_shared/mt-review-helpers.ts";
export type {
  Perspective,
  Width,
  Depth,
  Severity,
  Finding,
  FindingsJson,
  FilteredOutItem,
  VerdictJson,
  HunkCheckOutput,
  HunkBlockingThread,
} from "../_shared/mt-review-helpers.ts";

// =============================================================================
// Workflow Definition — orchestration only (logic split to _shared/mt-review-helpers.ts)
// =============================================================================

const def: WorkflowDef = {
  id: "mt-review-diff",
  description:
    "差分を敵対的に検証するワークフロー。width×depth の effort で 15 観点プールから検証者を割り当て、hunk 方式で指摘を提示し verdict まで完結する。",

  steps: [
    {
      key: "resolve_effort",
      phase: "effort 解決",
      type: "human_gate",
      maxRetries: 3,
      onFail: { action: "abort" },
      humanGate: {
        presentArtifacts: [],
        choices: [
          {
            value: "approve",
            label: "effort を確定して次へ",
            desc: "width/depth/base を確認し検証を開始する",
          },
          { value: "abort", label: "中断" },
        ],
      },
      check: (ctx: CheckCtx): CheckResult => {
        const raw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, EFFORT_KEY);
        if (!raw) {
          return {
            status: "pass",
            reasons: [
              "effort.json not found — will be generated with defaults width=medium depth=medium base=origin/main in collect_context",
            ],
          };
        }
        const parsed = parseJson(raw);
        if (!isRecord(parsed))
          return { status: "error", reasons: ["effort.json is not valid JSON"] };
        const width = parsed.width;
        const depth = parsed.depth;
        if (typeof width !== "string" || !VALID_WIDTHS.has(width)) {
          return {
            status: "fail",
            reasons: [
              `invalid width: ${String(width)}. expected one of ${[...VALID_WIDTHS].join(", ")}`,
            ],
          };
        }
        if (typeof depth !== "string" || !VALID_DEPTHS.has(depth)) {
          return {
            status: "fail",
            reasons: [
              `invalid depth: ${String(depth)}. expected one of ${[...VALID_DEPTHS].join(", ")}`,
            ],
          };
        }
        const baseErr = validateEffortBaseTarget(parsed.base, parsed.target);
        if (baseErr) {
          return { status: "fail", reasons: [baseErr] };
        }
        const round = typeof parsed.round === "number" ? parsed.round : 1;
        if (round > 3) {
          return {
            status: "fail",
            reasons: [
              `round limit exceeded: round=${round} > 3. 継続/中止を human_gate で選択してください`,
            ],
          };
        }
        return {
          status: "pass",
          reasons: [`effort: width=${width} depth=${depth} round=${round}`],
        };
      },
    },

    {
      key: "collect_context",
      phase: "差分収集",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const effortPath = join(ctx.sessionDir, EFFORT_KEY);
          const diffPath = join(ctx.sessionDir, "diff.txt");
          const effortQuoted = shellQuote(effortPath);
          const diffQuoted = shellQuote(diffPath);
          return [
            "## 目的",
            "",
            "敵対的検証の対象差分を収集し、以降の検証者が参照する証拠をセッションディレクトリに集約する。",
            "",
            "## 手順",
            "",
            `1. セッションディレクトリの ${EFFORT_KEY} (${effortPath}) を読み、width/depth/base/target を確認する。`,
            "   - effort.json がない場合は `tado next` のプロンプト記法 `width=… depth=… base=… target=…` を解析し、既定値 width=medium depth=medium base=origin/main として effort.json を作成する (pure な parseEffortArgs を参照)。",
            "   - base 未指定時は `git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'` で base を検出し、失敗時は main を使う。",
            "   - base/target は isValidGitRefName で検証し、不正な値（`..` や `;|&$` を含む）は拒否して error で停止する。",
            "",
            "2. 対象差分を収集する。base/target が指定されていればその範囲、なければ base..HEAD と unstaged を収集する:",
            "",
            "```bash",
            `BASE="$(jq -r '.base // empty' ${effortQuoted})"`,
            "BASE=\"${BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}\"",
            'BASE="${BASE:-main}"',
            `TARGET=$(jq -r '.target // empty' ${effortQuoted})`,
            `if [ -n "$TARGET" ]; then git diff "$BASE...$TARGET" > ${diffQuoted}; else git diff "$BASE...HEAD" > ${diffQuoted}; git diff >> ${diffQuoted}; fi`,
            `git ls-files --others --exclude-standard -z | xargs -0 -r sh -c 'for f; do git diff --no-index /dev/null "$f" 2>/dev/null; done' sh | head -n 5000 >> ${diffQuoted} || true`,
            `wc -l ${diffQuoted}`,
            "```",
            `3. 追加で git log --oneline -20 と git diff --stat を ${join(ctx.sessionDir, "context.md")} に保存する (検証者の文脈補強用)。`,
            "",
            "4. report 時の artifacts に以下を含める:",
            "```json",
            `[{"key": "diff.txt", "path": "${join(ctx.sessionDir, "diff.txt")}"}, {"key": "effort.json", "path": "${effortPath}"}]`,
            "```",
            "",
            "## 禁止事項",
            "",
            "- 対象差分以外の大規模なリポジトリ走査を行わない",
            "- workflow.db のループ制御に触れない",
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
            reasons: [ctx.attemptResult.errors ?? "collect_context failed"],
          };
        }
        const diffRaw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], "diff.txt", ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, "diff.txt");
        if (diffRaw === undefined) {
          return { status: "fail", reasons: ["diff.txt not found"] };
        }
        if (!diffRaw.trim()) {
          return { status: "pass", reasons: ["diff is empty — no changes to review"] };
        }
        return { status: "pass", reasons: [`diff collected: ${diffRaw.split("\n").length} lines`] };
      },
    },

    {
      key: "run_reviewers",
      phase: "検証者起動",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const effortRaw =
            findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
            readSessionFile(ctx.sessionDir, EFFORT_KEY);
          if (!effortRaw) {
            throw new Error(
              "effort.json not found — resolve_effort/collect_context must create effort.json before run_reviewers",
            );
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(effortRaw) as Record<string, unknown>;
          } catch {
            throw new Error("effort.json is not valid JSON");
          }
          const widthRaw = parsed.width;
          const depthRaw = parsed.depth;
          if (typeof widthRaw !== "string" || !VALID_WIDTHS.has(widthRaw)) {
            throw new Error(`invalid width: ${String(widthRaw)}`);
          }
          if (typeof depthRaw !== "string" || !VALID_DEPTHS.has(depthRaw)) {
            throw new Error(`invalid depth: ${String(depthRaw)}`);
          }
          const width = widthRaw as Width;
          const depth = depthRaw as Depth;
          const assignments = getReviewerAssignments(width, depth);
          const waves = getReviewerWaves(width, depth, 6);
          const diffPath = join(ctx.sessionDir, "diff.txt");

          const assignmentDesc = assignments
            .map(
              (perspectives, idx) =>
                `  - reviewer ${idx + 1}: ${perspectives.map((p) => `${p.label}(${p.id})`).join(", ")}`,
            )
            .join("\n");

          const waveDesc = waves
            .map(
              (wave, idx) => `  Wave ${idx + 1}: reviewers ${idx * 6 + 1}–${idx * 6 + wave.length}`,
            )
            .join("\n");

          return [
            "## 目的",
            "",
            "width×depth に応じて検証者を割り当て、敵対的検証を並列実行する。各検証者は担当観点のみを容赦なく突き、担当外観点の指摘は行わない。",
            "",
            "## effort と割り当て (機械的に導出 — LLM による動的選択は禁止)",
            "",
            `- width=${width} depth=${depth}`,
            `- 採用観点数: ${WIDTH_TO_COUNT[width]} (= ${getPerspectivesForWidth(width)
              .map((p) => p.label)
              .join(", ")})`,
            `- 担当観点数: ${DEPTH_TO_PER_COUNT[depth] === -1 ? "all" : String(DEPTH_TO_PER_COUNT[depth])} (depth=${depth})`,
            `- 検証者数: ${assignments.length} (= ceil(${WIDTH_TO_COUNT[width]} / ${DEPTH_TO_PER_COUNT[depth] === -1 ? WIDTH_TO_COUNT[width] : DEPTH_TO_PER_COUNT[depth]}))`,
            `- 波数: ${waves.length} (最大 6/波)`,
            "",
            "### 割り当て詳細",
            "",
            assignmentDesc,
            "",
            waveDesc,
            "",
            "## 手順",
            "",
            `1. セッションディレクトリの diff.txt (${diffPath}) と effort.json を読み込み、対象差分と effort を把握する。`,
            "   - diff.txt はサイズガード必須: 200KB または 8000行を超える場合は先頭 8000行のみを検証者に渡し、残りは `[... truncated: <残り行数> lines omitted]` と付記する。全文を無制限に複製しない。",
            "   - diff.txt が SoT であることを厳守: 指摘対象は diff.txt の `+` 行（追加/変更行）のみ。差分外ファイル・行への指摘は禁止。",
            "",
            '2. Task ツールで `subagent_type = "mt-review-diff-reviewer"` を波ごとに並列起動する (同一メッセージ内で最大 6 同時。波は直列で実行する)。',
            "   - 各 SubAgent には以下をプロンプト注入する:",
            "     - 担当検証観点の ID・名前・要約・ティア (上記割り当てから該当 reviewer のみ)",
            "     - width/depth と担当観点数 (専念度の文脈)",
            "     - 対象差分 (diff.txt の内容。サイズガードで切り詰めたもの。要約は行わないが truncate は必須)",
            "     - セッションディレクトリのパス",
            '     - **差分限定規律**: 指摘は diff.txt の `+` 行のみ。`filePath` 必須、`position` 必須（`side:"new"` かつ `line` は `+` 行の行番号）。`filePath` なし / `position` なし / `side:"old"` / diff外ファイル / `+` 行でない line は publish_findings で機械的に除外される。差分外の破壊（例: 呼び出し元が壊れる）は差分内の原因行に紐付けて記述し、差分外ファイルへの直接 `filePath` は禁止。読み取りは自由だが指摘の出力は差分内に制限。',
            "   - 各 SubAgent は `edit: deny / bash: deny`相当の read-only で動作し、担当外観点の指摘を禁止される。",
            '   - 各 SubAgent は findings 配列の JSON を返す (axis/severity/detail/position/suggestions)。`filePath` と `position:{side:"new", line}` は必須。',
            "",
            "3. 全検証者の findings を集約し、一時ファイルに保存する (publish_findings が findings.json として正規化するため、ここでは生の集約でよい):",
            "",
            "```bash",
            `cat > ${shellQuote(join(ctx.sessionDir, "reviewer-outputs.json"))} <<'JSON'`,
            "[{... findings from reviewers ...}]",
            "JSON",
            "```",
            "",
            `4. 集約した生 findings を ${join(ctx.sessionDir, "reviewer-outputs.json")} に保存し、report 時の artifacts に含める。findings.json の正規化・検証は次の publish_findings が行う。`,
            "",
            "## 検証スタンス (SubAgent へ徹底)",
            "",
            "検証者は「正しいことの確認」ではなく「崩せるかという反証」の視座で差分を突く。攻撃者・利用者・保守者の敵対視点で前提崩れ・悪用可能性・将来の保守破綻を暴露し、弱点を容赦なく指摘する。",
            "",
            "## 差分限定規律 (厳守 — SubAgent へ徹底)",
            "",
            "- 指摘は diff.txt の `+` 行（追加/変更行）のみに限定する。diff外ファイル・行への指摘は禁止",
            '- `filePath` 必須、 `position: {side:"new", line}` 必須。`side:"old"` / ファイルなし（general）/ positionなしは禁止',
            "- 差分外コードの読み取りは自由だが、指摘の出力は差分内に制限する",
            "- 差分起因で差分外が確実に壊れる場合でも、差分内の原因行に紐付けて指摘し、差分外ファイルへの直接 filePath は行わない",
            "- 違反は publish_findings で機械的に除外され `filteredOut` に記録される",
            "",
            "## 制約",
            "",
            "- 担当外観点の指摘は行わない (スコープ規律)",
            "- 差分外への指摘は行わない（上記差分限定規律）",
            "- ファイルの作成・修正は行わない (検証 Step は hunk と findings/verdict アーティファクトにのみ副作用を持つ)",
            "- workflow.db のループ制御に触れない",
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            `- diff: ${diffPath}`,
          ].join("\n");
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        if (ctx.attemptResult.status !== "completed") {
          return { status: "error", reasons: [ctx.attemptResult.errors ?? "run_reviewers failed"] };
        }
        return { status: "pass", reasons: ["reviewers executed"] };
      },
    },

    {
      key: "publish_findings",
      phase: "findings 公開",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const findingsPath = join(ctx.sessionDir, FINDINGS_KEY);
          const hunkCommentsPath = join(ctx.sessionDir, HUNK_COMMENTS_KEY);
          const hunkStartPath = join(ctx.sessionDir, HUNK_START_KEY);
          const effortPath = join(ctx.sessionDir, EFFORT_KEY);
          const reviewerOutputsPath = join(ctx.sessionDir, "reviewer-outputs.json");

          return [
            "## 目的",
            "",
            "検証者の生 findings を集約し、機械ルールで正規化した上で hunk セッションへ注入する。findings.json のスキーマ検証と STML 二重生成を行う。",
            "",
            "## 入力",
            "",
            `- reviewer-outputs.json (${reviewerOutputsPath}): run_reviewers が集約した生 findings (各 reviewer の JSON を結合した配列)`,
            `- effort.json (${effortPath}): width/depth/round`,
            `- diff.txt: 対象差分 (位置補正の参照用)`,
            "",
            "## 手順",
            "",
            "1. 生 findings を読み込み、以下の機械ルールで正規化する (純粋関数として実装 — LLM の恣意的な再解釈は禁止):",
            "   - 各 finding の axis が PERSPECTIVE_POOL の 15 観点に含まれるか検証 (未知 axis は除外し reasons に記録)",
            "   - severity が must/should/want のいずれかであることを検証",
            '   - filePath が必須、position が必須（side:"new"、line は正の整数）であることを検証（missing / old_side は除外し filteredOut に記録）',
            "   - diff.txt を parseDiffChangedLines でパースし `Map<filePath, Set<addedLines>>` を生成する（+++ b/<path> と @@ hunk の new側カウントで `+` 行を抽出。削除ファイル/bynary/ /dev/null はスキップ）",
            "   - filterFindingsByDiff で diff外ファイル / `+` 行でない line / missing_position / old_side を機械的に除外し `filteredOut: {count, items:[{axis,filePath,line,reason}]}` に記録する（reason: file_not_in_diff / line_not_in_added / missing_position / old_side / missing_filePath）",
            "   - 同一ファイルで ±2 行以内の findings はマージする (mergeFindingsByProximity 純粋関数。detail 連結、severity は must>should>want の最優先を継承、suggestions 結合)",
            "   - 除外後の kept について counts.must/should/want を再計算し、counts が厳密に一致することを検証",
            "",
            `2. 正規化した findings を findings.json (${findingsPath}) として書き出す。スキーマ:`,
            "```json",
            '{ "round": 1, "width": "medium", "depth": "medium", "findings": [{"axis":"req-1","severity":"must","detail":"...","filePath":"src/a.ts","position":{"side":"new","line":10}}], "counts":{"must":1,"should":0,"want":0}, "filteredOut":{"count":2,"items":[{"axis":"req-1","filePath":"src/b.ts","line":5,"reason":"line_not_in_added"}]} }',
            "```",
            "   - round は effort.json の round (なければ 1)",
            "   - width/depth は effort.json の値を継承",
            "   - filteredOut は任意。除外があった場合のみ count と items（axis/filePath/line/reason/detail）を記録し、人間へ透明に通知する",
            "",
            `3. findings.json を hunk comment apply 形式へ変換し、STML markup + summary を二重生成する (純粋関数 formatReviewComment / buildHunkComments):`,
            "   - severity: 🚨 must / ⚠️ should / 💡 want、taxonomy: 🐛 issue (must) / 🙋 question (should/want)",
            "   - axis: 15 観点の絵文字 (🎯 req-1 / 📋 req-2 / 🛡️ logic-1 / 🔒 logic-2 / 🧭 logic-3 / ⚡ logic-4 / 👁️ ai-1 / 🔌 ai-2 / ♻️ ai-3 / 🩹 ai-4 / 🧩 arch-1 / 🧱 arch-2 / 🎨 arch-3 / 🏷️ arch-4 / 🔗 arch-5)",
            "   - summary: `🚨 must · 🐛 issue · 🎯 req-1 | path:line — 詳細先頭` 形式 ([] を用いない)",
            "   - markup: STML の <box> で 4 ブロック (ヘッダ=title、対象ファイル/行、詳細本文、任意の提案リスト) を構造化。hunk diff --experimental で STML が描画され、非対応環境では summary が graceful fallback される",
            '   - filePath はリポジトリルートからの相対パスで必須。position は side:"new" のみ、newLine として hunk に渡す（general/oldLineは禁止。差分外の破壊は差分内の原因行に紐付けて記述）',
            "",
            `   変換結果を ${hunkCommentsPath} に JSON 配列として保存する (空配列でも保存する)。buildHunkComments 純粋関数を参照。`,
            "",
            "4. hunk セッションを確認し、コメントを注入する:",
            "```bash",
            "mt hunk status",
            "```",
            '   - "hunk review session: active" なら次へ進む',
            '   - "none" または "stale" なら `hunk diff <base-branch>` で TUI を起動してから再試行するよう report に記載する (このステップ自体は hunk セッションがなくても findings.json の生成までは成功として扱う)',
            "   - ベースブランチは origin/HEAD があればその参照名から origin/ を除き、なければ main を使う",
            "```bash",
            `BASE_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"`,
            'BASE_BRANCH="${BASE_BRANCH:-main}"',
            "```",
            "   - stdin からコメント JSON を渡し、mt hunk start を実行する:",
            "```bash",
            `cat ${shellQuote(hunkCommentsPath)} | mt hunk start | tee ${shellQuote(hunkStartPath)}`,
            "```",
            "",
            "5. report 時の artifacts に以下を含める:",
            "```json",
            `[{"key":"${FINDINGS_KEY}","path":"${findingsPath}"},{"key":"${HUNK_COMMENTS_KEY}","path":"${hunkCommentsPath}"},{"key":"${HUNK_START_KEY}","path":"${hunkStartPath}"}]`,
            "```",
            "",
            "## 制約",
            "",
            "- findings.json のスキーマ検証を必ず行う (validateFindingsJson — filePath必須/position必須/side:new を検証)",
            "- ±2 行マージは純粋関数で決定論的に行う (LLM の判断でマージしない)",
            "- diffフィルタは純粋関数 parseDiffChangedLines + filterFindingsByDiff で決定論的に行い、counts を再計算して filteredOut に透明に記録する",
            "- STML markup と summary を二重生成し、severity/taxonomy を継承する (must→issue, should/want→question)",
            "- workflow.db のループ制御に触れない",
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
            reasons: [ctx.attemptResult.errors ?? "publish_findings failed"],
          };
        }
        const raw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], FINDINGS_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, FINDINGS_KEY);
        const result = validateFindingsJson(raw);
        if (!result.valid) {
          return { status: "error", reasons: [result.error ?? "findings validation failed"] };
        }
        // 差分限定の機械的検証 — findings の全指摘が diff.txt の `+` 行に含まれることを検証
        const diffRaw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], "diff.txt", ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, "diff.txt");
        if (diffRaw !== undefined) {
          const changedMap = parseDiffChangedLines(diffRaw);
          for (const f of result.parsed!.findings) {
            const set = changedMap.get(f.filePath);
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
        const hunkRaw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], HUNK_START_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, HUNK_START_KEY);
        if (hunkRaw) {
          const started = findJsonObject(hunkRaw);
          if (started && (started.session === null || started.session === undefined)) {
            return {
              status: "fail",
              reasons: [
                `${HUNK_START_KEY} has no session. hunk セッションを active にして \`mt hunk start\` を再実行してください`,
              ],
            };
          }
        }
        return {
          status: "pass",
          reasons: [
            `findings: round=${result.parsed!.round} must=${result.parsed!.counts.must} should=${result.parsed!.counts.should} want=${result.parsed!.counts.want}`,
          ],
        };
      },
    },

    {
      key: "await_human_review",
      phase: "人間レビュー待機",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      humanGate: {
        presentArtifacts: [FINDINGS_KEY, HUNK_START_KEY, HUNK_COMMENTS_KEY],
        choices: [
          {
            value: "approve",
            label: "レビュー完了",
            desc: "hunk TUI で指摘の確認・人間コメントの追加を終え、verdict 判定へ進む",
          },
          { value: "abort", label: "中断" },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => {
        try {
          const active = isHunkSessionActive();
          if (active) return { status: "pass", reasons: ["hunk session is still active"] };
          return {
            status: "fail",
            reasons: ["hunk session not active — run `hunk diff <base-branch>` to activate"],
          };
        } catch (e) {
          return { status: "error", reasons: [`hunk session check error: ${String(e)}`] };
        }
      },
    },

    {
      key: "collect_verdict",
      phase: "verdict 収集",
      type: "task",
      maxRetries: 1,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          const verdictPath = join(ctx.sessionDir, VERDICT_KEY);
          const findingsPath = join(ctx.sessionDir, FINDINGS_KEY);
          const hunkCheckPath = join(ctx.sessionDir, HUNK_CHECK_KEY);
          return [
            "## 目的",
            "",
            "hunk 上のレビューを機械的に判定し、verdict.json を生成する。ラウンド上限 3 を gate し、verdict までで終端する (修正ループは消費者が所有)。",
            "",
            "## 手順",
            "",
            "1. `mt hunk check` を実行する。exit 0 = 通過、exit 1 = ブロック。exit 1 は未解決コメントによる通常のブロックなので、コマンド失敗として握り潰さず stdout JSON を取得する。",
            '2. stdout の passes / blocking_threads JSON (例: {"passes":true,"blocking_threads":[]}) をそのまま保存する。blocking_threads の body は原文のまま一字一句保持し、taxonomy ("issue" / "question" / "human") も変更しない。',
            `3. findings.json (${findingsPath}) を読み、round/width/depth を継承して verdict.json (${verdictPath}) を生成する:`,
            "```json",
            '{ "round": 1, "width": "medium", "depth": "medium", "passed": true, "blocking_threads": [], "findingsPath": "findings.json" }',
            "```",
            "   - passed は `mt hunk check` の passes と、findings の must が 0 かつ blocking_threads が空であることの両方が真のとき true",
            "   - blocking_threads は `mt hunk check` の blocking_threads をそのまま格納 (severity/taxonomy は findings の severity/taxonomy を継承し、mt バイナリ判定に準拠)",
            "   - round は findings.json の round を継承。3 を超える場合は human_gate で継続/中止を選択するため、verdict は生成するが report に round limit 到達を明記する",
            `4. JSON を ${verdictPath} と ${hunkCheckPath} に保存し、同じ JSON を report の subagentOutput として返す。`,
            `5. ラウンド上限 3 の判定: round >= 3 かつ passed=false の場合は、report に「round limit reached (3/3)」を明記し、次のアクションは human_gate で継続/中止を選択する旨を記載する (workflow.db のループ制御には触れない)。`,
            "",
            "## 制約",
            "",
            "- 検証 Step は hunk と findings/verdict アーティファクトにのみ副作用を持ち、workflow.db のループ制御に触れない (resetReviewCycle 相当は行わない)",
            "- verdict.json のスキーマ検証を必ず行う",
            "- severity/taxonomy は findings の severity から継承し、mt バイナリ判定に準拠する (must→issue, should/want→question)",
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
            reasons: [ctx.attemptResult.errors ?? "collect_verdict failed"],
          };
        }

        const daemon = parseHunkCheck(runHunkCommand(["check"]));
        const verdictRaw =
          findArtifactText(ctx.artifacts as ArtifactRecord[], VERDICT_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, VERDICT_KEY) ??
          ctx.attemptResult.subagentOutput;
        const verdictResult = validateVerdictJson(verdictRaw);
        if (!verdictResult.valid) {
          return { status: "error", reasons: [verdictResult.error ?? "verdict validation failed"] };
        }

        const verdict = verdictResult.parsed!;

        if (verdict.round > 3) {
          return {
            status: "fail",
            reasons: [
              `round limit exceeded: round=${verdict.round} > 3. 継続/中止を human_gate で選択してください`,
            ],
          };
        }
        if (verdict.round === 3 && !verdict.passed) {
          return {
            status: "fail",
            reasons: [
              `round limit reached (3/3) — verdict: passed=${verdict.passed}. 継続する場合は human_gate で選択してください`,
            ],
          };
        }

        if (daemon) {
          const reported =
            parseHunkCheck(verdictRaw) ??
            parseHunkCheck(
              findArtifactText(ctx.artifacts as ArtifactRecord[], HUNK_CHECK_KEY, ctx.sessionDir),
            );
          if (reported) {
            if (
              daemon.passes !== reported.passes ||
              JSON.stringify(daemon.blocking_threads) !== JSON.stringify(reported.blocking_threads)
            ) {
              return {
                status: "fail",
                reasons: [
                  "reported gate JSON does not match `mt hunk check` daemon output. `mt hunk check` を再実行し、stdout の JSON をそのまま report してください",
                ],
              };
            }
          }
        }

        const findingsRaw2 =
          findArtifactText(ctx.artifacts as ArtifactRecord[], FINDINGS_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, FINDINGS_KEY);
        const findingsResult2 = validateFindingsJson(findingsRaw2);
        if (findingsResult2.valid) {
          const mustCount = findingsResult2.parsed!.counts.must;
          if (mustCount > 0 && verdict.passed) {
            return {
              status: "fail",
              reasons: [`verdict passed=true but findings has must=${mustCount} blocking items`],
            };
          }
        }

        if (daemon) {
          try {
            fs.writeFileSync(
              join(ctx.sessionDir, HUNK_CHECK_KEY),
              `${JSON.stringify(daemon, null, 2)}\n`,
              "utf-8",
            );
          } catch (error) {
            return {
              status: "error",
              reasons: [`failed to persist hunk check output: ${String(error)}`],
            };
          }
        }

        return {
          status: "pass",
          reasons: [
            `verdict: round=${verdict.round} passed=${verdict.passed} blocking=${verdict.blocking_threads.length}`,
          ],
        };
      },
    },
  ],
};

export default def;

export const resolveEffortStep: StepDef = def.steps[0] as StepDef;
export const collectContextStep: StepDef = def.steps[1] as StepDef;
export const runReviewersStep: StepDef = def.steps[2] as StepDef;
export const publishFindingsStep: StepDef = def.steps[3] as StepDef;
export const awaitHumanReviewStep: StepDef = def.steps[4] as StepDef;
export const collectVerdictStep: StepDef = def.steps[5] as StepDef;
