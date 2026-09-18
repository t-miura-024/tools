import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import os from "node:os";
import { findArtifactText, readSessionFile } from "tado/artifacts";
import { reworkFeedbackSection } from "../../helper/rework-feedback-section.ts";
import { readRepoInfo } from "../../helper/read-repo-info.ts";

// -----------------------------------------------------------------
// Step 1: Grill Phase（事実収集 + 再検証grill）
// -----------------------------------------------------------------
export const grillStep: TaskStepDef = {
  key: "grill",
  phase: "Grill Phase",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const mtGrillRoundsDir = join(os.homedir(), ".cursor", "skills", "mt-grill-rounds");
      const grillMapPath = join(ctx.sessionDir, "grill-map.md");
      const analysisPath = join(ctx.sessionDir, "analysis.md");
      const evidencePath = join(ctx.sessionDir, "evidence.json");

      return [
        "## 目的",
        "",
        "既存Plan Issueを実行断面の事実で再検証し、通常の設計grill(Why/What/How)に加えて3点セットの観点でユーザーと合意形成する。",
        "",
        "3点セット:",
        "- (a) 前提の有効性: Issue作成時点の前提が今も成り立つか",
        "- (b) 要件の変化・欠落: 時間経過や追記プロンプトで要件が変わった/増えたか",
        "- (c) より良い代替選択肢: 現状の実装・周辺変更を踏まえたより良い案がないか",
        "",
        ...reworkFeedbackSection(ctx.gateAnswers, "confirm-analysis"),
        "## 入力",
        "",
        "- tado起動時に渡された `issue` (URLまたは番号) と `prompt` (追記要件) を確認する。未指定ならユーザーに確認する。",
        "- `gh issue view <number> --json title,body,labels,state,url,comments` で既存Issueを取得する。",
        "- 追記プロンプトと既存Issue本文を突き合わせ、矛盾があれば後段のgrillで3案提示する。",
        "",
        "## 手順",
        "",
        "### 1. 事実収集（SubAgent並列・必須）",
        "",
        "grillの進行役は自分で推測せず、必ずSubAgentに事実収集を委譲する（mt-grill-rounds原則: 事実はSubAgentが見つける）。",
        "軽量判定による省略は禁止。追記が軽微でも必ず3観点のSubAgentを派遣し、evidence.json に走査証跡を残す。",
        "",
        "Issue本文・コメント・紐づくPR/ブランチからキーワード/モジュール名/用語を抽出し、grep/globで候補ファイルを列挙する。",
        "抽出結果をもとに、観点ごとにSubAgentを並列派遣する:",
        "- 前提検証 SubAgent: 該当コード/スキーマ/ドキュメント/ADRを走査し、前提が崩れた箇所と根拠（ファイルパス・行・コミット）を収集",
        "- 要件差分 SubAgent: 追記プロンプトと既存完了条件/アウトプット/方針の差分を抽出し、欠落・変更点を整理",
        "- 競合・代替 SubAgent: 同一ファイル/モジュール/スキーマ/APIへの重複変更、ADR矛盾、マイグレーション競合を検出し、代替案の候補を列挙",
        "",
        "結果はセッションディレクトリに集約する:",
        '- `evidence.json` (JSON): 必須 { files: [{path, reason, commit, query, tool, timestamp}], mode: "full" }、任意 { relatedIssues, relatedPRs, conflicts }（検出時のみ）。各ファイルの commit は `git cat-file -e <commit>^{commit}` で実在検証し、存在しないハッシュは除外する',
        "- `analysis.md` (Markdown): 3章立てで整理",
        "  - ## 前提の有効性",
        "  - ## 要件の変化・欠落",
        "  - ## 代替選択肢",
        "  各項目に重要度(Blocker/Warning/Info)と根拠リンク（ファイルパス・コミット・Issue）を付与。Blockerは必ず3案（Issue優先/プロンプト優先/統合案）を用意。",
        "",
        "証跡の透明性（ai-1:159）: evidence.json 各エントリに { query, tool, timestamp } を必須記録する。",
        "",
        "### 2. 分析サマリの作成",
        "",
        `分析結果（\`analysis.md\` + \`evidence.json\` のサマリ）を \`${analysisPath}\` と \`${evidencePath}\` に保存する。次の human_gate で人間が確認する。`,
        "",
        "### 3. 徹底ヒアリング（mt-grill-rounds準拠）",
        "",
        `mt-grill-rounds スキル（${join(mtGrillRoundsDir, "SKILL.md")}）をロードし、その指示に従ってヒアリングを行う。`,
        "",
        "ヒアリングは mt-grill-rounds の方式に従って進める:",
        `- ライブ地図のパスは既定パスではなく \`${grillMapPath}\`（セッションディレクトリ配下）を明示的に指定し、このパスで地図を育成する`,
        "- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む",
        "- 質問生成は `analysis.md` + `evidence.json` の事実を根拠にし、3点セットの観点チェックリストを必ずカバーする",
        "- 前提崩れBlockerは3案提示して選択を迫る。Warning以下は確認のみ",
        "- 回答をライブ地図へ反映した後にフロンティアを再計算し、次のラウンドを提示する",
        "- フロンティアが空になり、ユーザーが共通認識を確認するまでラウンドを継続する",
        "",
        "### 4. ライブ地図の最終確認",
        "",
        `ヒアリングの全決定がセッションディレクトリのライブ地図 \`${grillMapPath}\` に蒸留されていることを確認する。`,
        "地図は Markdown 入れ子リスト＋状態マーカー（`[確定]` / `[未決]` / `[保留]`）の単一ファイルとし、質疑ログなどの別ファイルは残さない。",
        "Why/What/Howが漏れなく扱われ、3点セットの観点も反映されていることを確認する。",
        "",
        "## 成果物",
        "",
        "report 時の `artifacts` に以下を含める:",
        "```json",
        `[{"key": "grill-map.md", "path": "${grillMapPath}"}, {"key": "analysis.md", "path": "${analysisPath}"}, {"key": "evidence.json", "path": "${evidencePath}"}]`,
        "```",
        "",
        "## セッション情報",
        "",
        `- セッションディレクトリ: ${ctx.sessionDir}`,
      ].join("\n");
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    try {
      if (ctx.attemptResult.status !== "completed") {
        return { status: "error", reasons: [ctx.attemptResult.errors ?? "grill failed"] };
      }
      const grillMap =
        readSessionFile(ctx.sessionDir, "grill-map.md") ??
        findArtifactText(ctx.artifacts, "grill-map.md", ctx.sessionDir);
      if (!grillMap) return { status: "fail", reasons: ["grill-map.md not found"] };
      const analysis =
        readSessionFile(ctx.sessionDir, "analysis.md") ??
        findArtifactText(ctx.artifacts, "analysis.md", ctx.sessionDir);
      if (!analysis) return { status: "fail", reasons: ["analysis.md not found"] };
      const evidenceRaw =
        readSessionFile(ctx.sessionDir, "evidence.json") ??
        findArtifactText(ctx.artifacts, "evidence.json", ctx.sessionDir);
      if (!evidenceRaw) return { status: "fail", reasons: ["evidence.json not found"] };
      let evidence: any;
      try {
        evidence = JSON.parse(evidenceRaw);
      } catch {
        return { status: "fail", reasons: ["evidence.json is not valid JSON"] };
      }
      if (!Array.isArray(evidence.files) || evidence.files.length === 0)
        return {
          status: "fail",
          reasons: ["evidence.json: files must be non-empty array"],
        };
      if (evidence.mode !== "full") {
        return {
          status: "fail",
          reasons: [
            `evidence.json mode must be "full" (got ${JSON.stringify(evidence.mode)}) — SubAgent scan is mandatory`,
          ],
        };
      }
      for (const f of evidence.files) {
        if (!f.path || !f.query || !f.tool || !f.timestamp) {
          return {
            status: "fail",
            reasons: ["evidence.json: each file must have {path,query,tool,timestamp}"],
          };
        }
      }
      try {
        readRepoInfo(ctx.artifacts, ctx.sessionDir);
      } catch (e) {
        return { status: "fail", reasons: [`repo-info.json invalid: ${String(e)}`] };
      }
      return { status: "pass", reasons: ["grill artifacts verified"] };
    } catch (e) {
      return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
    }
  },
};
