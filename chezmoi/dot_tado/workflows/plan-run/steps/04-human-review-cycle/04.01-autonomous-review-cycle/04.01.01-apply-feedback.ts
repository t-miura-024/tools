import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { isRecord } from "../../../../shared/review-helpers/is-record";
import { buildStepPrompt } from "../../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../../shared/artifact-check/require-step-artifacts";
import { FEEDBACK_KEY, FEEDBACK_SOURCE_PATTERN, LOOP_OUTSIDE_GATE_KEYS } from "../../../types.ts";
import type { FeedbackItem } from "../../../types.ts";
import { collectGateReworkRequests } from "../../../helper/collect-gate-rework-requests.ts";
import { verifyFeedbackItems } from "../../../helper/verify-feedback-items.ts";
import { buildFeedbackCoverageExpected } from "../../../helper/build-feedback-coverage-expected.ts";

// -------------------------------------------------------------------
// Step 2.8: 指摘統合（plan-run 所有・自律 loop 先頭）
//         findings / verdict / difit の指摘と loop 内人間ゲートの request_changes
//         追加入力を統合し、修正指示を feedback.json へ組み立てる。
//         修正作業自体は行わず、execute-work の executor SubAgent に委譲する。
//         リポジトリのファイル編集は行わない。
// -------------------------------------------------------------------
export const applyFeedbackStep: TaskStepDef = {
  key: "apply-feedback",
  phase: "指摘統合",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const gateFeedbacks: string[] = [];
      // skip ゲートの stale 回答は同一写像で除外し、幽霊差し戻しを prompt に載せない。
      for (const { gateKey, input } of collectGateReworkRequests(ctx.gateAnswers, ctx)) {
        if ((LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(gateKey)) {
          gateFeedbacks.push(
            `- ${gateKey}: (⚠️ loop 外ゲートの差し戻しは巻き戻し不可のため統合できない。apply-feedback の check が fail で停止する)`,
          );
          continue;
        }
        if (input === undefined || input.trim() === "") {
          // 追加入力の欠落は "(追加入力なし)" で捏造しない。check が fail で止めるため、
          // ここでは異常の存在だけを記録する（異常系の正常系への偽装をしない）。
          gateFeedbacks.push(
            `- ${gateKey}: (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、apply-feedback の check が fail で停止する)`,
          );
          continue;
        }
        gateFeedbacks.push(`- ${gateKey}: ${input}`);
      }
      return buildStepPrompt({
        purpose: [
          "前回レビューサイクルの指摘を統合し、修正指示を feedback.json へ組み立てる。修正作業自体は行わない（execute-work の executor SubAgent が行う）。",
        ],
        criteria: [],
        approach: [
          {
            title: "人間ゲートの差し戻し（gateAnswers。原文のまま扱う）",
            content: [
              ...(gateFeedbacks.length > 0
                ? gateFeedbacks
                : ["- (なし。初回実行または前回 approve)"]),
              "",
            ],
          },
          {
            title: "手順",
            content: [
              "1. セッションディレクトリの `findings.json` を読み、must の全指摘を抽出する（should / want は自律対象外のため統合しない。feedback に含めても除外してもよい）",
              "2. セッションディレクトリの `verdict.json` と `difit-check.json` を読み、`blocking_threads[].body` と `replies`（人間 reply）を抽出する（`verdict.json` が SoT）",
              "3. 上記と「人間ゲートの差し戻し」を統合し、重複を除いて修正指示を組み立てる（要約・省略・taxonomy の変更をしない。人間コメント・人間 reply は原文のまま）",
              '4. 組み立てた修正指示をセッションディレクトリの `feedback.json` に保存する。契約: `{"items": [{"source": "<findings|verdict|difit|gate:<stepKey>>", "body": "<原文>"}]}`。修正ソースが無い実行では `{"items": []}` とする',
              "",
              "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
              "```json",
              `{"key": "feedback.json", "path": "${ctx.sessionDir}/feedback.json"}`,
              "```",
            ],
          },
        ],
        output: [],
        policy: [
          "- リポジトリのファイルを編集しない（修正作業は execute-work の executor が行う）",
          "- workflow.db に触れない（巻き戻しは loop の continue が行う）",
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.attemptResult.status !== "completed") {
      return {
        status: "error",
        reasons: [ctx.attemptResult.errors ?? "apply-feedback failed"],
      };
    }
    const base = requireStepArtifacts(ctx, [{ key: FEEDBACK_KEY, form: "json" }]);
    if (base.status !== "pass") return base;
    const raw =
      findArtifactText(ctx.artifacts, FEEDBACK_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, FEEDBACK_KEY);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw ?? "null");
    } catch (error) {
      return {
        status: "fail",
        reasons: [`${FEEDBACK_KEY} を JSON として読めません: ${String(error)}`],
      };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
      return {
        status: "fail",
        reasons: [`${FEEDBACK_KEY} は {"items": [...]} の形式である必要があります`],
      };
    }
    const items: FeedbackItem[] = [];
    for (const [index, item] of parsed.items.entries()) {
      if (!isRecord(item) || typeof item.source !== "string" || item.source.trim() === "") {
        return {
          status: "fail",
          reasons: [`${FEEDBACK_KEY}.items[${index}].source が空または文字列ではありません`],
        };
      }
      if (typeof item.body !== "string" || item.body.trim() === "") {
        return {
          status: "fail",
          reasons: [`${FEEDBACK_KEY}.items[${index}].body が空または文字列ではありません`],
        };
      }
      items.push({ source: item.source, body: item.body });
    }
    // gateAnswers との突合（shape のみ検証では捏造・欠落・別ソース混入が素通りする）。
    // skip ゲートの stale 回答は同一写像で除外する（世代管理。幽霊差し戻しの強制を防ぐ）。
    const requests = collectGateReworkRequests(ctx.gateAnswers, ctx);
    for (const { gateKey, input } of requests) {
      if ((LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(gateKey)) {
        return {
          status: "fail",
          reasons: [
            `${gateKey} は loop 外ゲートのため request_changes を巻き戻しできず、feedback.json へ統合できない（記録上通過するだけになり差し戻しが無音消失する）。abort して再実行するか、loop 内ゲートで差し戻してください`,
          ],
        };
      }
      if (input === undefined || input.trim() === "") {
        return {
          status: "fail",
          reasons: [
            `${gateKey} の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする（"(追加入力なし)" の捏造はしない）`,
          ],
        };
      }
    }
    // source 語彙の allowlist（捏造・別ソース混入の素通りを塞ぐ）。
    for (const [index, item] of items.entries()) {
      if (!FEEDBACK_SOURCE_PATTERN.test(item.source)) {
        return {
          status: "fail",
          reasons: [
            `${FEEDBACK_KEY}.items[${index}].source が未知の語彙です: ${item.source}（findings|verdict|difit|gate:<stepKey> のいずれか）`,
          ],
        };
      }
    }
    // 双方向の被覆検証（期待⊆実績・実績⊆期待）。items 非空でも findings must
    // 件数分・verdict blocking 被覆を検証し、ダミー混入・must 欠落を塞ぐ。
    // 空 items ガードはこの一般形に含める: 期待（gate 差し戻し / findings must /
    // verdict blocking）があるのに items が空なら fail。修正ソースなしの初回実行は
    // pass のまま。should-only は自律対象外のため items=[] で pass（should/want は任意）。
    // want 詳細は人間 reply 付きのみ blocking に現れるため findings 側では要求しない。
    // 期待の組み立ては execute-work と共有（build-feedback-coverage-expected）し、
    // 写像ドリフトを作らない。
    const coverage = verifyFeedbackItems(items, buildFeedbackCoverageExpected(ctx, requests), {
      strictBodyCoverage: true,
    });
    if (coverage.status !== "pass") return coverage;
    return {
      status: "pass",
      reasons: [
        items.length === 0
          ? `${FEEDBACK_KEY} を検証しました（統合する指摘なし）`
          : `${FEEDBACK_KEY} を検証しました（${items.length} 件の修正指示）`,
      ],
    };
  },
};
