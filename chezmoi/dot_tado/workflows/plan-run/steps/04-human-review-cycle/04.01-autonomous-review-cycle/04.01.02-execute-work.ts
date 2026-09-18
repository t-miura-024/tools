import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { isRecord } from "../../../../shared/review-helpers/is-record";
import { parseDifitCheck } from "../../../../shared/review-helpers/parse-difit-check";
import { isolateDifitFeedback } from "../../../../shared/review-helpers/isolate-difit-feedback";
import { describeDifitSelectionDrift } from "../../../../shared/review-helpers/describe-difit-selection-drift";
import { requireDifitSelectionDrift } from "../../../../shared/review-helpers/require-difit-selection-drift";
import { DIFIT_CHECK_KEY } from "../../../../shared/review-helpers/difit-check-key";
import { buildStepPrompt } from "../../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../../shared/artifact-check/require-step-artifacts";
import { FEEDBACK_KEY, LOOP_OUTSIDE_GATE_KEYS } from "../../../types.ts";
import type { FeedbackItem } from "../../../types.ts";
import { collectGateReworkRequests } from "../../../helper/collect-gate-rework-requests.ts";
import { verifyFeedbackItems } from "../../../helper/verify-feedback-items.ts";
import { buildFeedbackCoverageExpected } from "../../../helper/build-feedback-coverage-expected.ts";
import { resolveReviewFindings } from "../../../helper/resolve-review-findings.ts";
import { resolveReviewVerdict } from "../../../helper/resolve-review-verdict.ts";

// -------------------------------------------------------------------
// Step 3: 作業実行（executor SubAgent 委譲・並列）
// -------------------------------------------------------------------
export const executeWorkStep: TaskStepDef = {
  key: "execute-work",
  phase: "作業実行",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      // executor 向け difit フィードバック文面。taxonomy / blocking の権威は Rust の
      // `src/difit/gate.rs`。機械出力の値をそのまま表示しつつ、want 昇格（人間 reply が
      // 付いた want のみ blocking_threads に現れる）の説明を再記述する。review-diff の
      // NOTE(arch-1) が列挙する分類規則の同期対象であり、規則変更時は同時更新が必要。
      const difitFeedback: string | undefined = (() => {
        const raw =
          findArtifactText(ctx.artifacts, DIFIT_CHECK_KEY, ctx.sessionDir) ??
          readSessionFile(ctx.sessionDir, DIFIT_CHECK_KEY);
        const result = parseDifitCheck(raw);
        if (!result) return undefined;
        const drift = result.selection_drift;
        const driftFailure = drift && drift.detection !== "none" ? drift : undefined;
        const driftContract = requireDifitSelectionDrift(result);
        const driftViolation =
          "violation" in driftContract && result.selection_drift_error
            ? driftContract.violation
            : undefined;
        const contractViolations: string[] = [];
        if (result.passes && result.blocking_threads.length > 0) {
          contractViolations.push(
            `契約違反: passes=true なのに blocking_threads が ${result.blocking_threads.length} 件あります。mt difit check の契約では passes=true ⇒ blocking_threads 空です。blocking 一覧を無音で捨てず、下記を修正対象として提示します（difit CLI の出力契約変更を確認してください）`,
          );
        }
        if (
          result.blocking_threads.length === 0 &&
          !driftFailure &&
          !driftViolation &&
          contractViolations.length === 0
        ) {
          return undefined;
        }
        const lines = [
          "## difit の人間フィードバック（前回 collect-verdict の blocking_threads）",
          "",
          "以下は difit 上の未 resolve スレッドです。担当スコープに該当するものを修正してください。taxonomy / blocking は Rust 判定の値をそのまま使う。resolve 可否は taxonomy == human で判断する。",
          "want（`💡 want`）は人間 reply が付いたものだけが blocking_threads に現れる（人間が対話を求めた昇格分のみ修正対象）。",
          "",
        ];
        if (contractViolations.length > 0) {
          lines.push("## ⚠️ difit 出力の契約違反", "");
          for (const violation of contractViolations) {
            lines.push(violation, "");
          }
        }
        if (driftViolation) {
          lines.push(
            "## ⚠️ difit の選択状態を検証できません（契約違反）",
            "",
            driftViolation,
            "",
            "選択状態を確認できないため、executor は `mt difit resolve` を行わず、オーケストレーター経由で difit CLI の出力スキーマ（selection_drift）の確認と `mt difit start <base-branch>` によるセッション復旧を依頼してください。",
            "",
          );
        }
        if (driftFailure) {
          lines.push(
            driftFailure.detection === "detected"
              ? "## ⚠️ difit UI の選択ドリフト"
              : "## ⚠️ difit の選択状態を確認できません（検知不能）",
            "",
            describeDifitSelectionDrift(driftFailure),
            "",
            driftFailure.detection === "detected"
              ? "この状態で executor が `mt difit resolve` を実行してもゲートが読むセッションには反映されません。人間がセレクタを起動時の選択へ戻すまで resolve は行わず、オーケストレーター経由で復旧を依頼してください。"
              : "選択状態を確認できないため、executor は `mt difit resolve` を行わず、オーケストレーター経由で `mt difit start <base-branch>` による復旧を依頼してください。",
            "",
          );
        }
        for (const [index, thread] of result.blocking_threads.entries()) {
          const location = thread.file
            ? `${thread.file}${thread.line === undefined || thread.line === null ? "" : `:${typeof thread.line === "number" ? thread.line : `${thread.line.start}-${thread.line.end}`}`}`
            : "(file-level)";
          lines.push(`### ${index + 1}. ${location} (${thread.taxonomy ?? "unknown"})`);
          if (thread.taxonomy === "human") {
            lines.push(`人間コメント（原文）: ${thread.body}`);
          } else {
            lines.push(`指摘: ${thread.body}`);
            if (thread.replies && thread.replies.length > 0) {
              for (const reply of thread.replies) {
                lines.push(`人間 reply: ${reply}`);
              }
            } else {
              lines.push("人間 reply: (なし。未解決の指摘として確認する)");
            }
          }
          lines.push("");
        }
        return lines.join("\n").trim();
      })();
      return buildStepPrompt({
        purpose: [
          "計画 Issue の `## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針` に従って作業を実行する。",
          "作業の実施は必ず `mt-plan-work-executor` SubAgent に委譲する。オーケストレーター自身はリポジトリのファイル編集を行わず、ミッションの割り振り・進行管理・Issue body 更新に専念する。",
        ],
        criteria: [],
        approach: [
          {
            title: "修正ソース（再実行時に適用）",
            content: [
              "自律ループの先頭（apply-feedback）から戻ってきた場合、以下のソースから修正指示を統合して executor SubAgent に渡す:",
              "",
              "1. **feedback.json の統合指示**（apply-feedback が組み立てた修正指示。findings must / verdict / difit の指摘と人間ゲートの request_changes 追加入力を原文のまま含む。再実行時はこのファイルを最初に読む）",
              "2. **findings.json の must 指摘のみ**（run-reviewers の SubAgent レビューで検出された必須修正。should / want は自律対象外）",
              "3. **difit の blocking_threads のうち must 由来**（`difit-check.json` / `verdict.json` の blocking_threads。未 resolve スレッドを人間 reply 込みで含むが、should / want は自律対象外）",
              "",
              "各ソースの存在確認:",
              "- セッションディレクトリの `feedback.json` を読み、apply-feedback の統合指示を抽出する（feedback がある場合は、オーケストレーター自身の判断で握り潰さず executor への修正指示に原文のまま含める）",
              "- セッションディレクトリの `findings.json` を読み、must 指摘を抽出する（should / want は自律対象外のため executor への修正指示に含めない）",
              "- セッションディレクトリの `verdict.json` と `difit-check.json` を読み、`blocking_threads[].body` と `replies`（人間 reply）を抽出する（`verdict.json` が SoT。must 由来のみ修正対象）",
              "- 存在しないファイルは無視する（初回実行時は修正ソースなし）",
              "",
              "should / want 指摘の扱い:",
              "- should / want は自律対象外のため修正しない（should 修正に起因する新規 must 発生での発散を断つ）",
              "- should / want スレッドは未 resolve のまま残し、人間フェーズの判断に委ねる",
              "- must 修正に付随して should / want 箇所が偶発的に解消されることは許容するが、should / want 狙いの編集は禁止する",
              "",
              "修正指示の仕分け:",
              "- 指摘を該当ミッションのスコープで仕分けし、担当の executor SubAgent に修正指示として渡す",
              "- must のみ対応対象。should / want（人間 reply 付きを含む）は対応対象外",
              "- difit の人間コメント・人間 reply はテキスト原文として executor に渡し、要約・省略・taxonomy の変更をしない",
              "",
              "対応完了時のスレッド resolve:",
              "- executor は対応した AI 指摘のスレッドを `mt difit resolve <threadId>` で resolve する（state の読み取り → 記録 pid が記録 port を LISTEN していることの照合 → 選択固定セッションへの resolve までを 1 コマンドで行い、人間コメントのスレッドは拒否される。`.difit/difit-review.json` の port を直接読んで `difit` CLI を叩かない）",
              "- must（taxonomy issue）: 対応したスレッドを resolve する",
              "- should（taxonomy question）/ want: 自律では resolve しない。未 resolve のまま残す",
              "- 人間コメント（`taxonomy` == `human`）: resolve しない。修正が必要な場合も resolve は人間に委ね、未 resolve のまま残す",
              "",
              // difit 由来の動的文字列は素通し spread せず、原文維持のまま
              // コードフェンスで隔離して Section content へ渡す
              ...(difitFeedback ? [isolateDifitFeedback(difitFeedback), ""] : []),
            ],
          },
          {
            title: "1. ミッションの読み取り",
            content: [
              "Issue body（`gh issue view <number> --json body`）から `## 🧩 ミッション` セクションを読み取る（必須）:",
              "",
              "- `### 実行順` の Wave 定義と各 `### M<n>: <名前>` ミッションのスコープ・完了条件を把握する",
              "- セクションがない場合: 計画不備として実行を停止する（計画全体を 1 ミッションとして扱うフォールバックはしない）。当該番号のIssueが存在する場合は `plan-update`、存在しない新規の場合は `plan-create` で追記してから再実行する",
              "",
            ],
          },
          {
            title: "2. executor SubAgent の起動",
            content: [
              'Wave 方式に従って、Task ツールで `subagent_type = "mt-plan-work-executor"` を起動する:',
              "",
              "- 同じ Wave 内のミッションは並列起動する（最大 5 同時）。同一メッセージで複数の Task ツール呼び出しを行う",
              "- 異なる Wave は番号順に直列実行する（Wave 2 は Wave 1 の全ミッション完了後に開始）",
              "- 各 SubAgent に渡す情報:",
              "  - 計画 Issue body 全文（完了条件・方針・アウトプットの判断に必要）",
              "  - 担当ミッション定義（ID・名前・スコープ・完了条件番号・Wave 所属）",
              "  - 修正指示（再実行時のみ: findings.json、verdict.json/difit-check.json の blocking_threads / 人間 reply の該当指摘）",
              "",
            ],
          },
          {
            title: "executor の完了報告契約",
            content: [
              "各 executor は、作業結果を次の構造化 JSON オブジェクトとして必ず返す:",
              "```json",
              "{",
              '  "changedFiles": ["<repository-relative-path>"],',
              '  "checks": [{"command": "<command>", "result": "<result>"}],',
              '  "unresolvedIssues": []',
              "}",
              "```",
              "",
            ],
          },
          {
            title: "3. 完了報告の集約",
            content: [
              "- 全ミッションの完了報告（変更ファイル一覧・検証結果・未解決事項）を集約する",
              "- 集約結果をセッションディレクトリの `execution-result.json` に保存する（executor 返却 JSON をミッション単位でマージ）:",
              "",
              "```json",
              "{",
              '  "changedFiles": ["<repository-relative-path>"],',
              '  "checks": [{"command": "<command>", "result": "<result>"}],',
              '  "unresolvedIssues": []',
              "}",
              "```",
              "",
              "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
              "```json",
              `{"key": "execution-result.json", "path": "${ctx.sessionDir}/execution-result.json"}`,
              "```",
              "",
              "- ミッションがスコープ外変更の必要を報告した場合は、作業を止めてユーザーに計画修正を提案する",
              '- いずれかのミッションが失敗した場合は report を `status: "failed"` とし、失敗内容を errors に含める',
              "",
            ],
          },
          {
            title: "Issue body 更新（オーケストレーターが実施）",
            content: [
              "以下のタイミングで更新する:",
              "- 実行開始時: `## 🐢 履歴` へ開始を追記（`transition-plan.ts` が自動実行済み）",
              "- 全ミッション完了後: `## 🐢 履歴` へミッションごとの変更内容と確認結果を追記",
              "- 重要な判断があったとき: `## 🐿️ メモ` へ判断材料を追記",
              "- 中断時: `## 🐢 履歴` または `## 🐿️ メモ` へ完了済みミッション・次回再開位置・残論点を残す",
              "",
              "更新前は必ず `gh issue view` で body を読み、他者の差分を上書きしない。",
              "",
              "`## 🐿️ メモ` の運用:",
              "- `💭 背景:` … 前提・制約",
              "- `🤔 論点:` … 未決事項・要確認事項",
              "- `🧭 指針:` … 合意済み判断・運用ルール",
              "- 未解決の論点は Done 前に解消・方針へ取り込み・スコープ外化のいずれかを行う",
              "",
              "```bash",
              "gh issue edit <number> --repo <repo> --body-file <tmpfile>",
              "```",
            ],
          },
        ],
        output: [],
        policy: [
          "- オーケストレーター自身がリポジトリのファイルを編集しない（作業は必ず executor SubAgent へ委譲）",
          "- 計画外のファイル編集や状態遷移が必要になった場合は実行を止め、計画修正を提案する",
          "- ユーザー承認前に `done` 化しない",
          "- 全ミッションの完了前に次のステップへ進まない",
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.attemptResult.status !== "completed") {
      return {
        status: "error",
        reasons: [ctx.attemptResult.errors ?? "execute-work failed"],
      };
    }
    // 統一最低ライン: executor 返却 JSON の集約物を成果物として強制。
    // 内容の妥当性検証は下流の reviewer/verdict（daemon 突合）に委譲する。
    // apply-feedback との接続: gate 差し戻しがあるのに feedback.json の items が
    // 空・不在なら、差し戻しが握り潰されるため fail（LLM の申告だけに頼らない最小限の接続）。
    // skip ゲートの stale 回答は同一写像で除外する（世代管理）。
    // NOTE(logic-2): source 存在のみでは apply 通過後の差し替え（TOCTOU）や
    // dummy すり替えが素通りする。gate 差し戻し・must / blocking 時は
    // apply-feedback と同じ期待（build-feedback-coverage-expected）で正規化後厳密一致の
    // 双方向被覆を再検証し、無関係 body のみの素通りを fail にする。
    // should/want は自律対象外のため needsFeedback・被覆必須に含めない。
    // 原文の厳密被覆の SoT は apply-feedback であり、ここでは接続の再検証として
    // 同じ verify-feedback-items を使う（写像ドリフトを作らない）。
    const reworkRequests = collectGateReworkRequests(ctx.gateAnswers, ctx).filter(
      (r) => !(LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(r.gateKey),
    );
    const findingsForWork = resolveReviewFindings(ctx);
    const verdictForWork = resolveReviewVerdict(ctx);
    const needsFeedback =
      reworkRequests.length > 0 ||
      (findingsForWork !== undefined && findingsForWork.counts.must > 0) ||
      (verdictForWork !== undefined && verdictForWork.blocking_threads.length > 0);
    if (needsFeedback) {
      const feedbackRaw =
        findArtifactText(ctx.artifacts, FEEDBACK_KEY, ctx.sessionDir) ??
        readSessionFile(ctx.sessionDir, FEEDBACK_KEY);
      let feedbackItems: FeedbackItem[] | undefined;
      try {
        const feedbackParsed: unknown = JSON.parse(feedbackRaw ?? "null");
        feedbackItems =
          isRecord(feedbackParsed) &&
          Array.isArray(feedbackParsed.items) &&
          feedbackParsed.items.every(
            (entry: unknown) =>
              isRecord(entry) && typeof entry.source === "string" && typeof entry.body === "string",
          )
            ? (feedbackParsed.items as FeedbackItem[])
            : undefined;
      } catch {
        feedbackItems = undefined;
      }
      if (!feedbackItems || feedbackItems.length === 0) {
        const what =
          reworkRequests.length > 0
            ? `gate 差し戻し（${reworkRequests.map((r) => r.gateKey).join(", ")}）`
            : findingsForWork !== undefined && findingsForWork.counts.must > 0
              ? `findings must=${findingsForWork.counts.must} should=${findingsForWork.counts.should}`
              : `verdict blocking=${verdictForWork?.blocking_threads.length ?? 0}`;
        return {
          status: "fail",
          reasons: [
            `${what} があるのに ${FEEDBACK_KEY} の items が空または不在です。apply-feedback の統合指示が execute-work へ届いていません`,
          ],
        };
      }
      // gate 差し戻し・must・blocking の原文被覆を、apply-feedback と
      // 同じ期待で再検証する（apply 通過後の差し替え・dummy すり替えの検出）。
      const coverage = verifyFeedbackItems(
        feedbackItems,
        buildFeedbackCoverageExpected(ctx, reworkRequests),
        { strictBodyCoverage: true },
      );
      if (coverage.status !== "pass") return coverage;
    }
    return requireStepArtifacts(ctx, [
      {
        key: "execution-result.json",
        form: "json",
        keys: ["changedFiles", "checks", "unresolvedIssues"],
      },
    ]);
  },
};
