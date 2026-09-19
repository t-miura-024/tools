import type { ArtifactRecord, CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { shellQuote } from "../../../shared/review-helpers/shell-quote";
import { findJsonObject } from "../../../shared/review-helpers/find-json-object";
import { parseJson } from "../../../shared/review-helpers/parse-json";
import { isRecord } from "../../../shared/review-helpers/is-record";
import { readDifitReviewState } from "../../../shared/review-helpers/read-difit-review-state";
import { fetchDifitThreads } from "../../../shared/review-helpers/fetch-difit-threads";
import type { DifitThreadsFetchResult } from "../../../shared/review-helpers/types";
import { difitCommandFailureMessage } from "../../../shared/review-helpers/difit-command-failure-message";
import { difitStderrReasons } from "../../../shared/review-helpers/difit-stderr-reasons";
import { requireDifitSelectionDrift } from "../../../shared/review-helpers/require-difit-selection-drift";
import { describeDifitSelectionDrift } from "../../../shared/review-helpers/describe-difit-selection-drift";
import { diffDifitCommentPresence } from "../../../shared/review-helpers/diff-difit-comment-presence";
import { EFFORT_KEY } from "../../../shared/review-helpers/effort-key";
import { DIFIT_COMMENTS_KEY } from "../../../shared/review-helpers/difit-comments-key";
import { DIFIT_START_KEY } from "../../../shared/review-helpers/difit-start-key";
import { describeRecoveryCommand } from "../../helper/describe-recovery-command.ts";
import { difitSelectionReasons } from "../../helper/difit-selection-reasons.ts";
export const startDifitReviewStep: TaskStepDef = {
  key: "start-difit-review",
  phase: "difit レビュー起動",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const difitCommentsPath = join(ctx.sessionDir, DIFIT_COMMENTS_KEY);
      const difitStartPath = join(ctx.sessionDir, DIFIT_START_KEY);
      const effortPath = join(ctx.sessionDir, EFFORT_KEY);
      return [
        "## 目的",
        "",
        "normalize-findings が生成した difit コメント JSON を difit レビューセッションへ注入し、レビュー用の URL を人間へ提示する。",
        "このステップは起動・コメント注入・URL 提示だけを担当し、レビューの待機・ゲート判定・修正は行わない。",
        "",
        "## 手順",
        "",
        "1. ベースブランチとレビュー対象を解決する。effort.json の base があればそれを、なければ origin/HEAD から origin/ を除いた名前、失敗時は main を使う。target があればそれも解決する（target は collect-context が diff.txt を `git diff base...target` で収集する範囲）:",
        "```bash",
        `BASE="$(jq -r '.base // empty' ${shellQuote(effortPath)})"`,
        `BASE="\${BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"`,
        'BASE="${BASE:-main}"',
        `TARGET=$(jq -r '.target // empty' ${shellQuote(effortPath)})`,
        "```",
        "",
        `2. stdin から ${DIFIT_COMMENTS_KEY} のコメント JSON を渡して起動する。difit の第1引数が diff の target、第2引数が compare-with（base）であり、\`--merge-base\` で base...target（three-dot）の merge-base 解決になる（通常の base のみの起動は \`mt difit start\` が \`. <base> --merge-base\` へ変換するため same 範囲になる）:`,
        "```bash",
        `if [ -n "$TARGET" ]; then cat ${shellQuote(difitCommentsPath)} | mt difit start "$TARGET" "$BASE" --merge-base | tee ${shellQuote(difitStartPath)}; else cat ${shellQuote(difitCommentsPath)} | mt difit start "$BASE" | tee ${shellQuote(difitStartPath)}; fi`,
        "```",
        '- target 提示の根拠: collect-context は target があると diff.txt を `git diff "$BASE...$TARGET"` で収集する。difit に target を渡さず base 単独で起動すると、difit の提示差分（merge-base(base, HEAD)..working）と検証対象が乖離し、findings の position が無関係な行に紐づく。`"$TARGET" "$BASE" --merge-base` は `git diff $(git merge-base $TARGET $BASE) $TARGET` = `git diff $BASE...$TARGET` と同じ範囲を提示する（引数順に注意。difit の第2引数は compare-with=base）',
        "   - 再入時（前ラウンドからの継続）は `mt difit start` が同一引数の実行中サーバを再利用してコメントを追記する。毎回 kill → 再起動しない（ポート不変）",
        "   - stdout の JSON (`port` / `url` / `comments`) の `url` (`http://localhost:<port>`) を確認し、人間と report の subagentOutput へ提示する。人間はその URL をブラウザで開いてレビューする（表示の自動化は行わない）。次ステップ await-human-review の human gate も difit-start.json の url を開く手順を示す",
        "",
        "3. report 時の artifacts に以下を含める:",
        "```json",
        `[{"key":"${DIFIT_COMMENTS_KEY}","path":"${difitCommentsPath}"},{"key":"${DIFIT_START_KEY}","path":"${difitStartPath}"}]`,
        "```",
        "",
        "## 制約",
        "",
        `- ${DIFIT_COMMENTS_KEY} の再解釈・再生成は行わない（正規化は normalize-findings の責務）`,
        "- difit サーバの生死判定に文字列一致は使わない。状態は `.difit/difit-review.json`（port / pid / comments / difit_args / selection）の JSON 契約で扱う",
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
        reasons: [ctx.attemptResult.errors ?? "start-difit-review failed"],
      };
    }
    // start 成否検証: stdout 契約（port / url / comments）と .difit/difit-review.json の
    // live 状態、および選択固定セッション上の実コメントを突合する。
    // 読み取りは `mt difit threads --json`（state.selection に固定。unpinned な
    // `difit comment get` は使わない）に統一する。これにより 2 ラウンド目の再入で
    // `mt difit start` を実行せず前ラウンドの difit-start.json を残したまま通過する
    // 経路（start 未実行の偽装）と、ブラウザのリビジョン切替による別セッション読みの
    // 誤診断（誤った『start 再実行』誘導）を両方とも検出する。
    const startRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], DIFIT_START_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, DIFIT_START_KEY);
    if (!startRaw) {
      return { status: "fail", reasons: [`${DIFIT_START_KEY} not found`] };
    }
    const started = findJsonObject(startRaw);
    if (
      !started ||
      typeof started.port !== "number" ||
      typeof started.url !== "string" ||
      typeof started.comments !== "number"
    ) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_START_KEY} must contain {"port":<number>,"url":<string>,"comments":<number>} (mt difit start の stdout)`,
        ],
      };
    }
    // stdout 契約の url は port と整合する `http://localhost:<port>` であることを要求する。
    // URL だけ別セッション（別ポート）を指す偽装を検出する。
    const expectedUrl = `http://localhost:${started.port}`;
    if (started.url !== expectedUrl) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_START_KEY} の url=${started.url} が port=${started.port} と整合しません（期待: ${expectedUrl}）。前ラウンドの start 出力ではなく、今回の mt difit start の stdout を保存してください`,
        ],
      };
    }
    const stateRead = readDifitReviewState();
    if ("error" in stateRead) {
      return {
        status: "fail",
        reasons: [
          `.difit/difit-review.json を読み取れません: ${stateRead.error}。state の読み取り失敗を『セッション不在』と誤診しないため fail とします`,
        ],
      };
    }
    if ("missing" in stateRead) {
      return {
        status: "fail",
        reasons: [
          `difit session is not live. \`.difit/difit-review.json\` が見つかりません。${describeRecoveryCommand(ctx)} でセッションを開始してください`,
        ],
      };
    }
    const state = stateRead.state;
    let fetched: DifitThreadsFetchResult;
    try {
      fetched = fetchDifitThreads();
    } catch (error) {
      // 振り分けは difitCommandFailureMessage に集約（呼び出し元ごとの扱いは同関数の doc）。
      const failure = difitCommandFailureMessage(error);
      if (failure === undefined) throw error;
      return { status: "fail", reasons: [failure] };
    }
    const pinned = fetched.output;
    if (!pinned) {
      return {
        status: "fail",
        reasons: [
          "`mt difit threads --json`（選択固定・read-only）でスレッドを取得できませんでした。difit サーバ停止、state の選択キー未記録、同一性照合失敗、またはブラウザで別の選択に切り替わっている可能性があります",
          ...difitStderrReasons(fetched.stderr),
          `difit UI のリビジョンセレクタを起動時の選択へ戻したうえで、${describeRecoveryCommand(ctx)} でセッションを復旧してください`,
        ],
      };
    }
    // 選択ドリフト（`mt difit threads --json` の検知）は人間の reply / resolve が
    // ゲートの読むセッションと別の場所へ書き込まれる状態を意味する。フィールド欠落・
    // 解釈不能（契約違反）と probe 失敗の `unavailable`（検知不能）は「ドリフトなし」と
    // 混同せず fail-closed で止める（確認できないままレビューを進行させない）。
    const driftCheck = requireDifitSelectionDrift(pinned);
    if ("violation" in driftCheck) {
      return {
        status: "fail",
        reasons: [
          driftCheck.violation,
          ...difitStderrReasons(fetched.stderr),
          `difit CLI を更新した場合は \`mt difit threads --json\` の出力スキーマ（selection_drift の三値）を確認し、workflow 側を追従させてください。出力が契約を満たすまで ${describeRecoveryCommand(ctx)} でセッションを復旧しても通過できません`,
        ],
      };
    }
    const drift = driftCheck.drift;
    if (drift.detection !== "none") {
      return {
        status: "fail",
        reasons: [
          describeDifitSelectionDrift(drift),
          ...difitStderrReasons(fetched.stderr),
          drift.detection === "detected"
            ? `${describeRecoveryCommand(ctx)} は実行中サーバを再利用するため、difit UI のリビジョンセレクタを起動時の選択へ戻す操作は別途行ってください`
            : `${describeRecoveryCommand(ctx)} でセッションを復旧し、difit UI のリビジョンセレクタが起動時の選択を指していることを確認してください`,
        ],
      };
    }
    if (state.port !== started.port) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_START_KEY} の port=${started.port} が .difit/difit-review.json の port=${state.port} と不一致。前ラウンドの start 出力ではなく、今回の mt difit start の stdout を保存してください`,
        ],
      };
    }

    const commentsRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], DIFIT_COMMENTS_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, DIFIT_COMMENTS_KEY);
    if (commentsRaw === undefined) {
      return { status: "fail", reasons: [`${DIFIT_COMMENTS_KEY} not found`] };
    }
    const comments = parseJson(commentsRaw);
    if (!Array.isArray(comments)) {
      return { status: "fail", reasons: [`${DIFIT_COMMENTS_KEY} must be a JSON array`] };
    }
    if (started.comments !== comments.length) {
      return {
        status: "fail",
        reasons: [
          `mt difit start の stdout comments=${started.comments} が ${DIFIT_COMMENTS_KEY} の件数 ${comments.length} と不一致。今回の findings を注入した start の stdout を保存してください`,
        ],
      };
    }

    // 注入したコメントがサーバ上に実在することを body だけでなく
    // {filePath, position.side, position.line, body} の組（multiset）で突合する。
    // body の Set 比較では、位置・side を差し替えた注入（blocking 指摘を別行・
    // 別ファイルへ移して提示から逃れる経路）や、同一 body 2 件の片方欠落を
    // 検出できない。サーバ側の余剰は前ラウンドの未 resolve スレッド・人間
    // コメントとして許容する（containment 検証）。
    for (const [index, comment] of comments.entries()) {
      if (!isRecord(comment) || typeof comment.body !== "string" || !comment.body.trim()) {
        return {
          status: "fail",
          reasons: [`${DIFIT_COMMENTS_KEY}[${index}] must contain a non-empty body`],
        };
      }
    }
    const presence = diffDifitCommentPresence(comments, pinned.threads);
    if (!presence.match) {
      return {
        status: "fail",
        reasons: [
          `${DIFIT_COMMENTS_KEY} のコメントが difit サーバ上（選択固定セッション）に {filePath, position.side, position.line, body} の組（multiset）で見つかりません。欠落 ${presence.missing.length} 件: ${presence.missing.join(" / ") || "なし"}、キー生成不能 ${presence.invalid.length} 件: ${presence.invalid.join(" / ") || "なし"}。body が一致していても位置・side が差し替えられた注入や同一 body の片方欠落を検出しています。mt difit start が実行されていない（前ラウンドの difit-start.json を残している）か、ブラウザの選択が起動時と異なる可能性があります。state と選択を確認し、必要なら mt difit start を再実行して全コメントを注入してください`,
          ...difitStderrReasons(fetched.stderr),
        ],
      };
    }

    // 提示範囲と検証対象の整合: effort.json の base/target から期待される選択を解決し、
    // state.selection（difit が実際に提示している選択固定キー）と照合する。
    // target があるのに単独 base で起動した場合や、別選択のセッションを再利用した場合、
    // diff.txt（base...target）と difit の提示差分が乖離し、findings の position が
    // 人間に見えない行へ紐づく。ゲートの前提（提示差分 = 検証対象）をここで機械検証する。
    // 同じ写像を collect-verdict のゲート時再照合と共有する（TOCTOU の検出）。
    const selectionReasons = difitSelectionReasons(ctx);
    if (selectionReasons.length > 0) {
      return { status: "fail", reasons: selectionReasons };
    }

    return {
      status: "pass",
      reasons: [
        `difit review started (port=${started.port}, url=${started.url}, comments=${started.comments} verified on server)`,
        ...difitStderrReasons(fetched.stderr),
      ],
    };
  },
};
