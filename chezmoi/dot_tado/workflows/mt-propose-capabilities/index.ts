import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult, GateAnswers } from "tado";
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
  id: "mt-propose-capabilities",
  description:
    "対象リポジトリを軽量走査しCapability軸の企画候補を発掘するワークフロー。3視点の並列ブレストで15案を収集しdraft Issueとして起票する。",

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
              return [
                "## 目的",
                "",
                "対象 repo を軽量走査し、Capability 軸（新しい能力の獲得）の企画候補を 3 人の SubAgent で並列ブレストする。",
                "各 SubAgent は異なる視点で 5 案ずつ出し、合計 15 案を収集する。",
                "",
                "## 前回差し戻し",
                "",
                "gate:present_gate の request_changes 追加入力（原文のまま候補へ反映する）:",
                formatGateReworkFeedback(ctx.gateAnswers, "present_gate"),
                "",
                `反復: ${ctx.loop?.iteration ?? 1}/${ctx.loop?.maxIterations ?? 3}（上限到達時は loop 外の人間判断へ渡る）`,
                "",
                "## 手順",
                "",
                "### 1. 対象 repo の確認",
                "",
                "```bash",
                "gh repo view --json nameWithOwner",
                "```",
                "",
                "### 2. 3 SubAgent 並列起動",
                "",
                "Task ツールで 3 人の SubAgent を同一メッセージで並列起動する。各 SubAgent に以下を指示する:",
                "",
                "- 対象 repo の軽量走査（README・ディレクトリ構造・マニフェスト・docs・既存スキル定義・git log -20）",
                "- 指定された視点で 5 案の企画候補を抽出",
                "- 各候補に「タイトル」「背景（根拠を織り込む）」「走査根拠」を付与",
                "- 既存の仕組みで既にカバーされている能力は候補にしない",
                "- 既存 open Issue を確認し、重複しそうな案は避ける（二重防御）",
                "",
                "#### SubAgent 1: ユーザー体験向上",
                "",
                "「この repo のユーザー（= 自分）の日常的な体験を向上させる新しい能力は何か」の視点で 5 案。",
                "",
                "#### SubAgent 2: 開発効率向上",
                "",
                "「この repo の開発・保守を効率化する新しい能力は何か」の視点で 5 案。",
                "",
                "#### SubAgent 3: エコシステム拡張",
                "",
                "「この repo のエコシステム（連携ツール・プラグイン・外部サービス）を拡張する新しい能力は何か」の視点で 5 案。",
                "",
                "### 3. 結果の集約",
                "",
                "3 人の SubAgent から返却された合計 15 案を 1 つのリストにまとめる。",
                "各候補に以下の情報を含める:",
                "- タイトル",
                "- 背景（根拠を織り込んだ 2〜3 文）",
                "- 走査根拠（具体的なファイル・箇所）",
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
                '      "perspective": "ユーザー体験向上"',
                "    }",
                "  ]",
                "}",
                "```",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                "```json",
                `{"key": "brainstorm-results.json", "path": "${ctx.sessionDir}/brainstorm-results.json"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
                "",
                "## 禁止事項",
                "",
                "- repo のファイルを変更しない（読み取り専用）",
                "- Issue を起票しない",
                "- 候補の水増しをしない（各 SubAgent ちょうど 5 案）",
              ].join("\n");
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
              return [
                "## 目的",
                "",
                "ブレストで収集した 15 案と既存の open Issue/計画を照合し、重複を除外または注記する。",
                "",
                "## 手順",
                "",
                `### 1. brainstorm-results.json の読み込み`,
                "",
                `${ctx.sessionDir}/brainstorm-results.json から 15 案を読み込む。`,
                "",
                "### 2. 既存 Issue/計画の取得",
                "",
                "```bash",
                "gh issue list --state open --limit 50 --json number,title",
                `bun ${join(import.meta.dir, "../mt-plan-run/mt-plan-list-plans.ts")} draft refined in-progress`,
                "```",
                "",
                "### 3. 照合・判定",
                "",
                "各候補を既存 Issue/計画のタイトルと照合する:",
                "",
                "- **同一テーマ**: 候補から除外し、除外理由を記録する",
                "- **関連テーマ**: 候補に残し「既存 Issue #N に関連」と注記する",
                "- **無関係**: そのまま候補に残す",
                "",
                "### 4. 結果の保存",
                "",
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
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                "```json",
                `{"key": "dedup-results.json", "path": "${ctx.sessionDir}/dedup-results.json"}`,
                "```",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
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
              return [
                "## 目的",
                "",
                "重複チェック後の候補（最大 15 案）を 3 人のレビュアー SubAgent で並列採点し、上位 5 案を選出する。",
                "",
                "## 手順",
                "",
                `### 1. dedup-results.json の読み込み`,
                "",
                `${ctx.sessionDir}/dedup-results.json から候補リストを読み込む。`,
                "",
                "### 2. 3 レビュアー SubAgent 並列起動",
                "",
                "Task ツールで 3 人のレビュアーを同一メッセージで並列起動する。",
                "各レビュアーは自分の観点で全候補を 1〜5 点で採点する。",
                "",
                "#### レビュアー 1: インパクト",
                "",
                "「その能力が日常のワークフローをどれだけ変えるか。頻度 × 効果の大きさ」で採点。",
                "",
                "#### レビュアー 2: 実現可能性",
                "",
                "「既存の技術・依存・スキルで現実的に実装できるか。未知の技術リスクがないか」で採点。",
                "",
                "#### レビュアー 3: 優位性",
                "",
                "「既存ツールや他のスキルに対する優位があるか。この repo に置く必然性があるか」で採点。",
                "",
                "各レビュアーの返却形式:",
                "",
                "```json",
                "{",
                '  "criterion": "インパクト",',
                '  "scores": [',
                '    { "id": 1, "score": 4, "comment": "..." },',
                '    { "id": 2, "score": 3, "comment": "..." }',
                "  ]",
                "}",
                "```",
                "",
                "### 3. 集計・選出",
                "",
                "3 観点の合計点で降順ソートし、上位 5 案を選出する。",
                "同点の場合はレビュアーのコメントを添えてユーザーに最終判断を委ねる（present_gate で提示）。",
                "",
                "### 4. 結果の保存",
                "",
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
                '      "scores": { "インパクト": 4, "実現可能性": 5, "優位性": 3 },',
                '      "total": 12,',
                '      "comments": { "インパクト": "...", "実現可能性": "...", "優位性": "..." }',
                "    }",
                "  ]",
                "}",
                "```",
                "",
                "## 成果物",
                "",
                "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
                "```json",
                `{"key": "review-results.json", "path": "${ctx.sessionDir}/review-results.json"}`,
                "```",
                "",
                "### 5. present_gate での提示フォーマット",
                "",
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
                "│   インパクト: 4 / 実現可能性: 5 / 優位性: 3 → 合計: 12",
                "│",
                "│ 📎 注記",
                "│   既存 Issue #N に関連（該当時のみ。なければ省略）",
                "└─────────────────────────────────────────────────",
                "```",
                "",
                "提示後に以下を促す:",
                "",
                "「起票する候補の番号を教えてください（複数可、例: 1,3,5）。すべて見送る場合は「なし」と入力してください。」",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n");
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
              [
                "## 目的",
                "",
                "present_gate の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
                "",
                "## 指示",
                "",
                "- 状態を変更しない（read-only）。ファイルの作成・編集をしない",
                "- report のみ行い、分岐判定が check に委ねられていることを報告する",
                "",
                "## セッション情報",
                "",
                `- セッションディレクトリ: ${ctx.sessionDir}`,
              ].join("\n"),
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
          return [
            "## 目的",
            "",
            "ユーザーが選択した候補を最小構成の draft Issue として起票する。",
            "",
            "## 手順",
            "",
            "### 1. label の確認・自動作成",
            "",
            "```bash",
            'gh label create kind/plan --repo <owner>/<repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true',
            "```",
            "",
            "### 2. Issue 作成",
            "",
            "各選択候補について `gh issue create` で起票する。",
            "",
            "- **本文はタイトル + `## 💭 背景` のみの最小構成**とする。完了条件・方針・ミッションは書かない",
            "- 背景には走査根拠と企画の意図を自然に織り込む",
            "- 重複チェックで注記がある場合は背景末尾に `関連: #N` を追記する",
            "",
            "```bash",
            "gh issue create --repo <owner>/<repo> \\",
            '  --title "<タイトル>" \\',
            '  --body "## 💭 背景',
            "",
            "<背景本文（根拠を織り込む）>",
            "",
            "## 🐢 履歴",
            '" \\',
            '  --label "kind/plan"',
            "```",
            "",
            "### 3. Project 追加・Status 設定",
            "",
            "`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。",
            "",
            "```bash",
            "gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json",
            "gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>",
            "```",
            "",
            "### 4. 報告",
            "",
            "起票結果を報告する:",
            "- 各 Issue の URL、タイトル、Status",
            "- 起票しなかった候補の一覧",
            "- 次ステップの案内: 「具体化は `mt-plan-create` の from-Issue フローで取り込めます」",
            "",
            "## 成果物",
            "",
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
            "",
            "## セッション情報",
            "",
            `- セッションディレクトリ: ${ctx.sessionDir}`,
            "",
            "## 禁止事項",
            "",
            "- ユーザーが選択しなかった候補を起票しない",
            "- 本文に完了条件・方針・ミッションを含めない",
          ].join("\n");
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
