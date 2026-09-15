import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult, GateAnswers } from "tado";
import { buildStepPrompt } from "../_shared/mt-prompt";
import { join } from "node:path";
import fs from "node:fs";
import { requireStepArtifacts } from "../_shared/artifact-check";
import { verifyIssueOpenLabeled } from "../_shared/gh-issue-verify";

// ---------------------------------------------------------------------------
// 候補サイクル（human gate revise の loop 置換）
//   present_gate の request_changes 差し戻しは、旧 revise 相当として
//   loop の判定 continue で brainstorm 先頭へ巻き戻る（再作業→再提示）。
//   巻き戻し先は旧 `reviseTargetStep: "brainstorm"` を本体先頭に据える
//   （`git show HEAD:...` で復元。worktree では revise 撤去済みのため request_changes が後継語彙）。
//   上限（3 反復）到達時は judge が pass で loop を抜け、loop 外の
//   present_exhausted_gate（approve/abort のみ）で人間が受容・中断を選ぶ。
//   内側 present_gate は無条件で毎反復再実行されるため常に最新回答が現世代であり、
//   世代管理の registry は設けない。全読み取りは gateDecisionValue /
//   gateDecisionInput 純粋関数に一本化する（幽霊差し戻しを作らない）。
//   confirm_done は語彙なしのため対象外・変更しない。
// NOTE(arch-2): buildStepPrompt は _shared/mt-prompt.ts 経由に集約済み（純粋フォーマッターであり ADR-0019 の StepDef 限定と競合しない）。
// ---------------------------------------------------------------------------

/// gate 回答の契約外形状に fail-closed な record 判定。
function isGateAnswerRecord(value: unknown): value is { value?: unknown; input?: unknown } {
  return typeof value === "object" && value !== null;
}

/// loop 内 human_gate の decision 回答値の読み取り（純粋関数）。
/// choice_with_input 回答は `{ value, input? }`、single_choice 回答は文字列。
/// 未回答・契約外形状は undefined（呼び出し元の fail 経路へ載せる）。
function gateDecisionValue(gateAnswers: GateAnswers, stepKey: string): string | undefined {
  const answer = gateAnswers[stepKey]?.["decision"];
  if (typeof answer === "string") return answer;
  if (isGateAnswerRecord(answer) && typeof answer.value === "string") return answer.value;
  return undefined;
}

/// loop 内 human_gate の decision 追加入力の読み取り（純粋関数）。
/// 文字列以外の input は欠落扱い（undefined）とする。
function gateDecisionInput(gateAnswers: GateAnswers, stepKey: string): string | undefined {
  const answer = gateAnswers[stepKey]?.["decision"];
  if (isGateAnswerRecord(answer) && typeof answer.input === "string") return answer.input;
  return undefined;
}

/// gate 回答値の純粋判定（plan-run の decideGateRework 定型）。
/// approve → pass / request_changes → continue / abort → error / 未知・未回答 → fail。
/// 旧 revise 値は受理しない（互換シムなし。fail の理由で移行先を案内する）。
/// loop 外の check は continue を返さない（エンジンが fail-fast する）。
function decideGateRework(value: string | undefined): "pass" | "continue" | "error" | "fail" {
  if (value === "approve") return "pass";
  if (value === "request_changes") return "continue";
  if (value === "abort") return "error";
  return "fail";
}

/// loop 枯渇の検出（present_exhausted_gate の condition 本体）。
/// judge は request_changes でしか continue を返さないため、loop 脱出後に内側ゲートの
/// 最新回答が request_changes なら上限到達（最終反復の pass 抜け）とみなす。
/// approve 脱出（正常 pass）・abort／未知・未回答では false（常時提示はしない）。
/// 内側 present_gate は無条件で毎反復再実行されるため常に最新回答が現世代であり、
/// 世代管理の registry は設けない（投機的一般化を避ける）。読み取りは下記の
/// gateDecisionValue / gateDecisionInput 純粋関数に一本化する（幽霊差し戻しを作らない）。
function isPresentExhausted(ctx: { gateAnswers: GateAnswers }): boolean {
  return gateDecisionValue(ctx.gateAnswers, "present_gate") === "request_changes";
}

/// loop 先頭 worker への差し戻し注入文面。request_changes の追加入力を原文のまま載せる。
/// 回答なし・approve・abort・未知値は「なし」扱い（abort は judge が error で止める）。
/// gateAnswers のみで判定する純粋関数（ConditionCtx への暗黙変換はしない）。
function formatGateReworkFeedback(gateAnswers: GateAnswers, stepKey: string): string {
  const value = gateDecisionValue(gateAnswers, stepKey);
  if (value !== "request_changes") return "- (なし。初回実行または前回 approve)";
  const input = gateDecisionInput(gateAnswers, stepKey);
  if (input === undefined || input.trim() === "") {
    return `- ${stepKey}: (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、judge の check が fail で停止する)`;
  }
  return `- ${stepKey}: ${input}`;
}

const def: WorkflowDef = {
  id: "mt-propose-quality",
  description:
    "対象リポジトリのコード品質を分析しQuality軸の改善候補を発掘するワークフロー。コード健全性・テスト充実などの視点で15案を収集しdraft Issue化する。",

  steps: [
    // -------------------------------------------------------------------
    // 候補サイクル（human gate revise の loop 置換。旧 reviseTargetStep
    // = brainstorm を本体先頭に据える）
    //   maxIterations は 3、onExhausted は escalate。上限到達時は judge の pass 抜けを
    //   経て loop 外の present_exhausted_gate（approve/abort のみ）へ渡る。
    //   反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
    //   brainstorm へ巻き戻る（report の nextAction は repeat）。
    //   loop 外で check が continue を返すとエンジンが fail-fast する。
    // -------------------------------------------------------------------
    {
      key: "candidate_cycle",
      phase: "候補サイクル",
      type: "loop",
      maxIterations: 3,
      onExhausted: "escalate",
      body: [
        {
          key: "brainstorm",
          phase: "ブレスト（候補サイクル先頭）",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              return buildStepPrompt({
                purpose: [
                  "対象 repo のコード品質を分析し、Quality 軸（既存の質の向上）の企画候補を 3 人の SubAgent で並列ブレストする。",
                  "各 SubAgent は異なる視点で 5 案ずつ出し、合計 15 案を収集する。",
                ],
                criteria: [],
                approach: [
                  {
                    title: "1. 対象 repo の確認",
                    content: [
                      "```bash",
                      "gh repo view --json nameWithOwner",
                      "```",
                      "",
                      "ユーザーが特定のディレクトリ・モジュールを指定していれば走査範囲を絞る。",
                    ],
                  },
                  {
                    title: "2. 3 SubAgent 並列起動",
                    content: [
                      "Task ツールで 3 人の SubAgent を同一メッセージで並列起動する。各 SubAgent に以下を指示する:",
                      "",
                      "- 対象 repo の品質分析（指定された視点に重点を置いて走査）",
                      "- 5 案の企画候補を抽出",
                      "- 各候補に「タイトル」「背景（根拠を織り込む）」「具体的なファイル・行・症状」を付与",
                      "- 既存 open Issue を確認し、重複しそうな案は避ける（二重防御）",
                      "- アーキテクチャ深化の重いテーマは背景に `mt-improve-codebase-architecture` 連携の注記を含める",
                      "",
                      {
                        title: "SubAgent 1: コードの健全性",
                        content: [
                          "複雑度・浅い module・重複コード・エラーハンドリング・unwrap/パニックリスクの観点で 5 案。",
                          "走査の優先度: 最近の変更が多い箇所（git log -30 で頻出パス）→ 長大ファイル → 重複パターン。",
                          "",
                        ],
                      },
                      {
                        title: "SubAgent 2: テスト・検証の充実",
                        content: [
                          "テスト不足・カバレッジの低い領域・テスト規約違反の観点で 5 案。",
                          "走査の優先度: テストファイルが存在しない主要モジュール → テスト規約（README の Rule 等）との乖離。",
                          "",
                        ],
                      },
                      {
                        title: "SubAgent 3: ドキュメント・保守性",
                        content: [
                          "ドキュメント陳腐化・README と実装の乖離・TODO/FIXME の集積・依存の古さの観点で 5 案。",
                          "走査の優先度: README のテーブルと実装の照合 → TODO/FIXME コメント → 非推奨 API の使用。",
                        ],
                      },
                    ],
                  },
                  {
                    title: "3. 結果の集約",
                    content: [
                      "3 人の SubAgent から返却された合計 15 案を 1 つのリストにまとめる。",
                      "各候補に以下の情報を含める:",
                      "- タイトル",
                      "- 背景（根拠を織り込んだ 2〜3 文）",
                      "- 具体的な根拠（ファイル・行・症状）",
                      "- 視点（どの SubAgent の案か）",
                      "",
                      "集約結果をセッションディレクトリに `brainstorm-results.json` として保存する:",
                      "",
                      "```json",
                      "{",
                      '  "candidates": [',
                      "    {",
                      '      "id": 1,',
                      '      "title": "...",',
                      '      "background": "...",',
                      '      "evidence": "...",',
                      '      "perspective": "コードの健全性"',
                      "    }",
                      "  ]",
                      "}",
                      "```",
                    ],
                  },
                ],
                output: [
                  "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                  "```json",
                  `{"key": "brainstorm-results.json", "path": "${ctx.sessionDir}/brainstorm-results.json"}`,
                  "```",
                ],
                policy: [
                  "- repo のファイルを変更しない（読み取り専用）",
                  "- Issue を起票しない",
                  "- 候補の水増しをしない（各 SubAgent ちょうど 5 案）",
                ],
                input: [
                  {
                    title: "前回の差し戻し",
                    content: [
                      "gate:present_gate の request_changes 追加入力。原文のまま候補へ反映する:",
                      formatGateReworkFeedback(ctx.gateAnswers, "present_gate"),
                      "",
                    ],
                  },
                  `セッションディレクトリ: ${ctx.sessionDir}`,
                  `反復: ${ctx.loop?.iteration ?? 1}/${ctx.loop?.maxIterations ?? 3}（上限到達時は loop 外の人間判断へ渡る）`,
                ],
              });
            },
          },
          // 統一最低ライン: 申告義務・実在・スキーマ（15 案 = 各 SubAgent 5 案 × 3）を強制
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [
              {
                key: "brainstorm-results.json",
                form: "json",
                minItems: 15,
                itemKeys: ["id", "title", "background", "evidence", "perspective"],
              },
            ]);
          },
        },

        {
          key: "dedup_check",
          phase: "重複チェック",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              return buildStepPrompt({
                purpose: [
                  "ブレストで収集した 15 案と既存の open Issue/計画を照合し、重複を除外または注記する。",
                ],
                criteria: [],
                approach: [
                  {
                    title: "1. brainstorm-results.json の読み込み",
                    content: [`${ctx.sessionDir}/brainstorm-results.json から 15 案を読み込む。`],
                  },
                  {
                    title: "2. 既存 Issue/計画の取得",
                    content: [
                      "```bash",
                      "gh issue list --state open --limit 100 --json number,title,labels",
                      `bun ${join(import.meta.dir, "../mt-plan-run/mt-plan-list-plans.ts")} draft refined in-progress`,
                      "```",
                    ],
                  },
                  {
                    title: "3. 照合・判定",
                    content: [
                      "各候補を既存 Issue/計画のタイトルと照合する:",
                      "",
                      "- **同一テーマ**: 候補から除外し、除外理由を記録する",
                      "- **関連テーマ**: 候補に残し「既存 Issue #N に関連」と注記する",
                      "- **無関係**: そのまま候補に残す",
                    ],
                  },
                  {
                    title: "4. 結果の保存",
                    content: [
                      `重複チェック後の候補リストを ${ctx.sessionDir}/dedup-results.json に保存する:`,
                      "",
                      "```json",
                      "{",
                      '  "candidates": [',
                      "    {",
                      '      "id": 1,',
                      '      "title": "...",',
                      '      "background": "...",',
                      '      "evidence": "...",',
                      '      "perspective": "...",',
                      '      "note": "既存 Issue #N に関連"',
                      "    }",
                      "  ],",
                      '  "excluded": [',
                      '    { "id": 5, "title": "...", "reason": "Issue #N と同一テーマ" }',
                      "  ]",
                      "}",
                      "```",
                    ],
                  },
                ],
                output: [
                  "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                  "```json",
                  `{"key": "dedup-results.json", "path": "${ctx.sessionDir}/dedup-results.json"}`,
                  "```",
                ],
                input: [`セッションディレクトリ: ${ctx.sessionDir}`],
              });
            },
          },
          // 統一最低ライン: 申告義務・実在・スキーマ（candidates/excluded）を強制
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [
              {
                key: "dedup-results.json",
                form: "json",
                keys: ["candidates", "excluded"],
                itemKeys: ["id", "title"],
              },
            ]);
          },
        },

        {
          key: "review_score",
          phase: "レビュー・採点",
          type: "task",
          maxRetries: 3,
          onFail: { action: "escalate" },
          task: {
            action: "orchestrate",
            buildPrompt: (ctx: PromptCtx) => {
              return buildStepPrompt({
                purpose: [
                  "重複チェック後の候補（最大 15 案）を 3 人のレビュアー SubAgent で並列採点し、上位 5 案を選出する。",
                ],
                criteria: [],
                approach: [
                  {
                    title: "1. dedup-results.json の読み込み",
                    content: [`${ctx.sessionDir}/dedup-results.json から候補リストを読み込む。`],
                  },
                  {
                    title: "2. 3 レビュアー SubAgent 並列起動",
                    content: [
                      "Task ツールで 3 人のレビュアーを同一メッセージで並列起動する。",
                      "各レビュアーは自分の観点で全候補を 1〜5 点で採点する。",
                      "",
                      {
                        title: "レビュアー 1: 深刻度",
                        content: [
                          "「放置した場合のリスク。バグ・パニック・データ損失・保守不能化の可能性」で採点。",
                          "",
                        ],
                      },
                      {
                        title: "レビュアー 2: 修正容易性",
                        content: [
                          "「少ない変更で改善できるか。大規模リファクタなしで着手できるか」で採点。",
                          "",
                        ],
                      },
                      {
                        title: "レビュアー 3: 波及効果",
                        content: [
                          "「その修正が他の改善の前提になるか。直すことで連鎖的に良くなるか」で採点。",
                          "",
                        ],
                      },
                      "各レビュアーの返却形式:",
                      "",
                      "```json",
                      "{",
                      '  "criterion": "深刻度",',
                      '  "scores": [',
                      '    { "id": 1, "score": 4, "comment": "..." },',
                      '    { "id": 2, "score": 3, "comment": "..." }',
                      "  ]",
                      "}",
                      "```",
                    ],
                  },
                  {
                    title: "3. 集計・選出",
                    content: [
                      "3 観点の合計点で降順ソートし、上位 5 案を選出する。",
                      "同点の場合はレビュアーのコメントを添えてユーザーに最終判断を委ねる（present_gate で提示）。",
                    ],
                  },
                  {
                    title: "4. 結果の保存",
                    content: [
                      `採点結果を ${ctx.sessionDir}/review-results.json に保存する:`,
                      "",
                      "```json",
                      "{",
                      '  "ranked": [',
                      "    {",
                      '      "id": 3,',
                      '      "title": "...",',
                      '      "background": "...",',
                      '      "evidence": "...",',
                      '      "note": "...",',
                      '      "scores": { "深刻度": 4, "修正容易性": 5, "波及効果": 3 },',
                      '      "total": 12,',
                      '      "comments": { "深刻度": "...", "修正容易性": "...", "波及効果": "..." }',
                      "    }",
                      "  ]",
                      "}",
                      "```",
                    ],
                  },
                  {
                    title: "5. present_gate での提示フォーマット",
                    content: [
                      "present_gate では上位 5 案を以下のフォーマットでユーザーに提示する。",
                      "推奨度は合計点から算出: 3-5=★1, 6-7=★2, 8-9=★3, 10-11=★4, 12-15=★5",
                      "",
                      "```",
                      "┌─────────────────────────────────────────────────",
                      "│ [1] <タイトル>",
                      "│     推奨度: ★★★★☆",
                      "├─────────────────────────────────────────────────",
                      "│ 💭 背景",
                      "│   <2〜3文の背景説明>",
                      "│",
                      "│ 🔍 根拠",
                      "│   <具体的なファイル・箇所>",
                      "│",
                      "│ ⭐ 推奨理由",
                      "│   <なぜこの推奨度か>",
                      "│",
                      "│ 📊 評価",
                      "│   深刻度: 4 / 修正容易性: 5 / 波及効果: 3 → 合計: 12",
                      "│",
                      "│ 📎 注記",
                      "│   既存 Issue #N に関連（該当時のみ。なければ省略）",
                      "└─────────────────────────────────────────────────",
                      "```",
                      "",
                      "提示後に以下を促す:",
                      "",
                      "「起票する候補の番号を教えてください（複数可、例: 1,3,5）。すべて見送る場合は「なし」と入力してください。」",
                    ],
                  },
                ],
                output: [
                  "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                  "```json",
                  `{"key": "review-results.json", "path": "${ctx.sessionDir}/review-results.json"}`,
                  "```",
                ],
                input: [`セッションディレクトリ: ${ctx.sessionDir}`],
              });
            },
          },
          // 統一最低ライン: 申告義務・実在・スキーマ（ranked + scores）を強制
          check: (ctx: CheckCtx): CheckResult => {
            return requireStepArtifacts(ctx, [
              {
                key: "review-results.json",
                form: "json",
                keys: ["ranked"],
                minItems: 1,
                itemKeys: ["id", "title", "scores", "total"],
              },
            ]);
          },
        },

        {
          key: "present_gate",
          phase: "候補提示（候補サイクル本体）",
          type: "human_gate",
          maxRetries: 1,
          onFail: { action: "abort" },
          humanGate: {
            presentArtifacts: [],
            outcomeQuestionKey: "decision",
            questions: [
              {
                key: "decision",
                title: "判定",
                type: "choice_with_input",
                choices: [
                  {
                    value: "approve",
                    label: "選択した",
                    desc: "起票する候補を選択した",
                    input: { required: false, maxLength: 500 },
                  },
                  {
                    value: "request_changes",
                    label: "候補をやり直す",
                    desc: "judge_present が gateAnswers を読んで loop 先頭（brainstorm）へ巻き戻し、入力した理由を反映して候補を再収集する",
                    input: { required: true, placeholder: "やり直す理由を入力", maxLength: 500 },
                  },
                  { value: "abort", label: "中断", desc: "起票せず終了する" },
                ],
              },
            ],
          },
          // human_gate は確認と回答保存のみを行い、巻き戻しは行わない。差し戻しは
          // judge_present が gateAnswers を読んで判定 `continue` で行い、本体先頭の
          // brainstorm へ巻き戻る。
          check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
        },

        // -------------------------------------------------------------------
        // 提示差し戻し判定（candidate_cycle 末尾）
        //   present_gate の gateAnswers を読んで分岐する loop の check。
        //   approve → pass / request_changes → 判定 `continue` で本体先頭
        //   （brainstorm）へ巻き戻る / abort → error / 未知・未回答 → fail。
        //   request_changes は追加入力の非空を軽量検証する（body 非空。
        //   source は当該ゲート固定読みで対応）。最終反復の request_changes は
        //   pass で loop を抜け、loop 外の present_exhausted_gate で人間が
        //   受容・中断を判断する（loop 外の continue はエンジンが fail-fast する）。
        // -------------------------------------------------------------------
        {
          key: "judge_present",
          phase: "提示差し戻し判定",
          type: "task",
          maxRetries: 0,
          onFail: { action: "abort" },
          task: {
            action: "orchestrate",
            readonly: true,
            buildPrompt: (ctx: PromptCtx) =>
              buildStepPrompt({
                purpose: [
                  "present_gate の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
                ],
                criteria: [],
                approach: ["- report のみ行い、分岐判定が check に委ねられていることを報告する"],
                policy: ["- 状態を変更しない（read-only）。ファイルの作成・編集をしない"],
                output: [],
                input: [`セッションディレクトリ: ${ctx.sessionDir}`],
              }),
          },
          check: (ctx: CheckCtx): CheckResult => {
            // 配置ガード: judge は自 loop 内でのみ実行される。文脈不一致は異常として止める。
            // iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
            // engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
            // judge は iteration >= maxIterations で先回りして pass 抜けする。
            // overshoot（iteration > max）でも pass 抜けとして fail-closed にする。
            if (ctx.loop?.key !== "candidate_cycle") {
              return {
                status: "error",
                reasons: [
                  `present_gate の判定は candidate_cycle 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）。定義と実行状態の不一致のため停止する`,
                ],
              };
            }
            const value = gateDecisionValue(ctx.gateAnswers, "present_gate");
            const decision = decideGateRework(value);
            if (decision === "pass") {
              return { status: "pass", reasons: ["present_gate approved — proceed"] };
            }
            if (decision === "error") {
              return {
                status: "error",
                reasons: [
                  "present_gate で中断 (abort) が選択されました。loop の継続判定（continue / pass）は行いません",
                ],
              };
            }
            if (decision === "fail") {
              return {
                status: "fail",
                reasons: [
                  value === undefined
                    ? "present_gate が実行されましたが gateAnswers に回答がありません"
                    : `present_gate の回答値が想定外です: ${value}（approve / request_changes のいずれか。旧 revise 値は撤去済みのため request_changes を使ってください）`,
                ],
              };
            }
            const input = gateDecisionInput(ctx.gateAnswers, "present_gate");
            if (input === undefined || input.trim() === "") {
              return {
                status: "fail",
                reasons: [
                  "present_gate の request_changes に追加入力がありません（input required:true の契約違反）。再入力を求めるため fail とする",
                ],
              };
            }
            if (ctx.loop.iteration >= ctx.loop.maxIterations) {
              return {
                status: "pass",
                reasons: [
                  `上限到達（反復 ${ctx.loop.iteration}/${ctx.loop.maxIterations}）のため request_changes のまま candidate_cycle を抜け、present_exhausted_gate で人間が受容・中断を判断します。未反映の差し戻し（gate:present_gate）: ${input}`,
                ],
              };
            }
            return {
              status: "continue",
              reasons: ["present_gate request_changes — rewind candidate_cycle to brainstorm"],
            };
          },
        },
      ], // candidate_cycle body
    },

    // -------------------------------------------------------------------
    // 提示上限判断（loop 外・枯渇時のみ提示）
    //   candidate_cycle が上限（3 反復）に達しても request_changes のままの
    //   場合のみ condition が true になり、人間が受容して起票へ進むか中断するかを選ぶ。
    //   human_gate は確認と回答保存のみを行い、巻き戻しは行わない。
    //   loop 外のため選択肢は approve/abort のみとし、request_changes は
    //   持たせない（巻き戻しが起きず記録上通過するだけの未配線選択肢になるため）。
    //   上限未達（approve 脱出）では skipped となり、draft 起票へ進む。
    // -------------------------------------------------------------------
    {
      key: "present_exhausted_gate",
      phase: "提示上限判断",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "abort" },
      condition: isPresentExhausted,
      // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
      // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
      humanGate: {
        presentArtifacts: [],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            description:
              "候補提示が上限（3 反復）に達しても候補のやり直し（request_changes）のままです。loop は既に終了しているため、このゲートでブレストへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。未反映の差し戻し内容は gate の回答履歴（present_gate の request_changes 追加入力）で確認してください。現状の候補を受容して起票へ進むか、中断するかを選択してください",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "受容して起票へ進む",
                desc: "現状の候補で draft 起票へ進む",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断", desc: "起票せず終了する" },
            ],
          },
        ],
      },
    },

    {
      key: "create_drafts",
      phase: "draft 起票",
      type: "task",
      maxRetries: 3,
      onFail: { action: "escalate" },
      task: {
        action: "orchestrate",
        buildPrompt: (ctx: PromptCtx) => {
          return buildStepPrompt({
            purpose: ["ユーザーが選択した候補を最小構成の draft Issue として起票する。"],
            criteria: [],
            approach: [
              {
                title: "1. label の確認・自動作成",
                content: [
                  "```bash",
                  'gh label create "kind/plan" --repo <owner/repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true',
                  "```",
                ],
              },
              {
                title: "2. Issue 作成",
                content: [
                  "各選択候補について `gh issue create` で起票する。",
                  "",
                  "- **本文はタイトル + `## 💭 背景` のみの最小構成**とする。完了条件・方針・ミッションは書かない",
                  "- 背景には走査根拠と企画の意図を自然に織り込む",
                  "- アーキテクチャ深化を含む場合は背景に `mt-improve-codebase-architecture` 連携の注記を含める",
                  "- 重複チェックで注記がある場合は背景末尾に `関連: #N` を追記する",
                  "",
                  // gh body 例示はフェンス文字列内に隔離する（先頭が ``` のため
                  // PromptString の行頭#検査に触れない。連結ハックは使わない）。
                  '```bash\ngh issue create --repo <owner/repo> \\\n  --title "<タイトル>" \\\n  --body "## 💭 背景\n\n<背景本文（根拠を織り込む）>\n\n## 🐢 履歴\n" \\\n  --label "kind/plan"\n```',
                ],
              },
              {
                title: "3. Project 追加・Status 設定",
                content: [
                  "`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。",
                  "",
                  "```bash",
                  "gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json",
                  "gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>",
                  "```",
                ],
              },
              {
                title: "4. 報告",
                content: [
                  "起票結果を報告する:",
                  "- 各 Issue の URL、タイトル、Status",
                  "- 起票しなかった候補の一覧",
                  "- 次ステップの案内: 「具体化は `mt-plan-create` の from-Issue フローで取り込めます」",
                ],
              },
            ],
            output: [
              "起票した Issue の一覧をセッションディレクトリの `issue-numbers.json` に保存する:",
              "",
              "```json",
              '[{ "number": 123, "title": "<タイトル>" }]',
              "```",
              "",
              "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
              "```json",
              `{"key": "issue-numbers.json", "path": "${ctx.sessionDir}/issue-numbers.json"}`,
              "```",
            ],
            policy: [
              "- ユーザーが選択しなかった候補を起票しない",
              "- 本文に完了条件・方針・ミッションを含めない",
            ],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          });
        },
      },
      // 統一最低ライン+ 副作用実照合: 起票一覧の申告と GitHub 実態を突き合わせる
      check: (ctx: CheckCtx): CheckResult => {
        const result = requireStepArtifacts(ctx, [
          { key: "issue-numbers.json", form: "json", minItems: 1, itemKeys: ["number", "title"] },
        ]);
        if (result.status !== "pass") return result;
        const raw = fs.readFileSync(join(ctx.sessionDir, "issue-numbers.json"), "utf-8");
        const created = JSON.parse(raw) as { number: unknown }[];
        const reasons: string[] = [];
        for (const entry of created) {
          reasons.push(...verifyIssueOpenLabeled(String(entry.number), "kind/plan"));
        }
        return reasons.length > 0
          ? { status: "fail", reasons }
          : { status: "pass", reasons: [`${created.length} issue(s) verified on GitHub`] };
      },
    },

    {
      key: "confirm_done",
      phase: "完了確認",
      type: "human_gate",
      maxRetries: 1,
      onFail: { action: "escalate" },
      humanGate: {
        presentArtifacts: [],
        outcomeQuestionKey: "decision",
        questions: [
          {
            key: "decision",
            title: "判定",
            type: "choice_with_input",
            choices: [
              {
                value: "approve",
                label: "Done",
                desc: "完了として終了する",
                input: { required: false, maxLength: 500 },
              },
              { value: "abort", label: "中断" },
            ],
          },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    },
  ],
};

export default def;
