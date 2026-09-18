import type { FeedbackCoverageExpected, FeedbackItem } from "../types.ts";
import { FEEDBACK_KEY } from "../types.ts";

/// feedback.json の body と期待原文の比較（前後空白の正規化後の厳密一致）。
/// includes 部分一致では「原文埋め＋任意追記」が pass し、追記文が executor への
/// 修正指示として混入する prompt-injection 経路になる。契約（`{"body": "<原文>"}`）
/// どおり原文そのものを要求し、正規化で吸収できる前後空白以外の差分は fail とする。
function feedbackBodyEquals(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

/// feedback.json の items に対する双方向の被覆検証（純粋関数）。
/// 期待集合⊆実績集合（欠落検出）と実績集合⊆期待集合（余剰・捏造検出）の両方向を行う。
/// body と期待原文の突合は feedbackBodyEquals（正規化後厳密一致）で行う。
/// includes 部分一致では「原文埋め＋任意追記」が pass する後退になるため使わない。
/// 空 items の素通り防止はこの一般形に含める（期待があれば空でも fail、期待なしの空は pass）。
/// 呼び出し元: apply-feedback の check（厳密・全文被覆）、execute-work の check
/// （軽量・source 対応。原文被覆の厳密検証は apply-feedback が担う）。
/// 期待の解決: findings（must 詳細のみ必須・should/want は任意）・verdict（blocking 全文）・difit（blocking 全文）。
/// should/want 詳細は自律対象外のため、findings 側では必須化しない（有っても無くてもよい）。
/// want 詳細は人間 reply 付きのみ blocking に現れるため、findings 側では要求しない。
export function verifyFeedbackItems(
  items: FeedbackItem[],
  expected: FeedbackCoverageExpected,
  opts: { strictBodyCoverage: boolean },
): { status: "pass" | "fail"; reasons: string[] } {
  const reasons: string[] = [];
  const bySource = (source: string): FeedbackItem[] => items.filter((i) => i.source === source);

  // 実績→期待（余剰・捏造の検出）。allowlist 通過だけでは偽 body 混入が素通りする。
  for (const [index, item] of items.entries()) {
    if (item.source.startsWith("gate:")) {
      const key = item.source.slice("gate:".length);
      if (!expected.knownStepKeys.has(key)) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}].source が未知のゲートです: ${item.source}（ワークフロー定義に存在しない stepKey）`,
        );
        continue;
      }
      const request = expected.gateInputs.find((r) => r.gateKey === key);
      if (!request) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (${item.source}) に対応する gate 差し戻しがありません。余剰の混入として fail とする`,
        );
        continue;
      }
      if (opts.strictBodyCoverage && !feedbackBodyEquals(item.body, request.input)) {
        reasons.push(
          `${key} の request_changes 追加入力が feedback.json の items（source=gate:${key}）に原文のまま含まれていません。差し戻しの欠落として fail とする`,
        );
      }
    } else if (item.source === "findings") {
      if (!expected.findingsAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=findings) に対応する findings.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        expected.findingDetails.length === 0 ||
        (opts.strictBodyCoverage &&
          !expected.findingDetails.some((f) => feedbackBodyEquals(item.body, f.detail)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=findings) の body が findings.json のいずれの指摘詳細とも一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    } else if (item.source === "verdict") {
      if (!expected.verdictAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=verdict) に対応する verdict.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        expected.verdictTexts.length === 0 ||
        (opts.strictBodyCoverage &&
          !expected.verdictTexts.some((t) => feedbackBodyEquals(item.body, t)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=verdict) の body が verdict.json の blocking と一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    } else if (item.source === "difit") {
      if (!expected.difitAvailable && !expected.verdictAvailable) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=difit) に対応する difit-check.json / verdict.json がありません。余剰の混入として fail とする`,
        );
      } else if (
        (expected.difitTexts.length === 0 && expected.verdictTexts.length === 0) ||
        (opts.strictBodyCoverage &&
          !expected.difitTexts.some((t) => feedbackBodyEquals(item.body, t)) &&
          !expected.verdictTexts.some((t) => feedbackBodyEquals(item.body, t)))
      ) {
        reasons.push(
          `${FEEDBACK_KEY}.items[${index}] (source=difit) の body が difit / verdict の blocking と一致しません。捏造・別ソース混入の疑いで fail とする`,
        );
      }
    }
  }

  // 期待→実績（欠落の検出）。items 非空でも must 件数分・blocking 被覆を検証する。
  // should/want は自律対象外のため必須化しない（must 修正に起因する新規 must 発生での
  // 発散を断つ。should/want が feedback に有っても無くてもよい）。
  if (opts.strictBodyCoverage) {
    for (const { gateKey, input } of expected.gateInputs) {
      // 実績→期待側で既に報告済みの gate は重複報告しない（対応 item が無い場合のみ）。
      if (bySource(`gate:${gateKey}`).some((i) => feedbackBodyEquals(i.body, input))) continue;
      if (!reasons.some((r) => r.includes(gateKey) && r.includes("原文のまま"))) {
        reasons.push(
          `${gateKey} の request_changes 追加入力が feedback.json の items（source=gate:${gateKey}）に原文のまま含まれていません。差し戻しの欠落として fail とする`,
        );
      }
    }
    for (const f of expected.findingDetails) {
      if (f.severity !== "must") continue;
      if (bySource("findings").some((i) => feedbackBodyEquals(i.body, f.detail))) continue;
      reasons.push(
        `findings[${f.index}] (${f.severity}) の指摘詳細が feedback.json の items（source=findings）に原文のまま含まれていません。指摘の欠落として fail とする`,
      );
    }
    for (const [i, text] of expected.verdictTexts.entries()) {
      if (bySource("verdict").some((item) => feedbackBodyEquals(item.body, text))) continue;
      reasons.push(
        `verdict blocking[${i}] が feedback.json の items（source=verdict）に原文のまま含まれていません。blocking の欠落として fail とする`,
      );
    }
  }

  return reasons.length > 0 ? { status: "fail", reasons } : { status: "pass", reasons: [] };
}
