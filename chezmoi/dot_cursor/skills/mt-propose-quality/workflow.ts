import type {
  WorkflowDef,
  CheckCtx,
  PromptCtx,
  CheckResult,
} from 'tado';
import { buildStepPrompt } from 'tado/prompt';
import { join } from 'node:path';

const def: WorkflowDef = {
  id: 'mt-propose-quality',

  steps: [
    {
      key: 'brainstorm',
      phase: 'ブレスト',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) =>
          buildStepPrompt({
            purpose: [
              '対象 repo のコード品質を分析し、Quality 軸（既存の質の向上）の企画候補を 3 人の SubAgent で並列ブレストする。\n各 SubAgent は異なる視点で 5 案ずつ出し、合計 15 案を収集する。',
            ],
            criteria: [],
            approach: [
              `### 1. 対象 repo の確認\n\n\`\`\`bash\ngh repo view --json nameWithOwner\n\`\`\`\n\nユーザーが特定のディレクトリ・モジュールを指定していれば走査範囲を絞る。`,
              `### 2. 3 SubAgent 並列起動\n\nTask ツールで 3 人の SubAgent を同一メッセージで並列起動する。各 SubAgent に以下を指示する:\n\n- 対象 repo の品質分析（指定された視点に重点を置いて走査）\n- 5 案の企画候補を抽出\n- 各候補に「タイトル」「背景（根拠を織り込む）」「具体的なファイル・行・症状」を付与\n- 既存 open Issue を確認し、重複しそうな案は避ける（二重防御）\n- アーキテクチャ深化の重いテーマは背景に \`mt-improve-codebase-architecture\` 連携の注記を含める\n\n#### SubAgent 1: コードの健全性\n\n複雑度・浅い module・重複コード・エラーハンドリング・unwrap/パニックリスクの観点で 5 案。\n走査の優先度: 最近の変更が多い箇所（git log -30 で頻出パス）→ 長大ファイル → 重複パターン。\n\n#### SubAgent 2: テスト・検証の充実\n\nテスト不足・カバレッジの低い領域・テスト規約違反の観点で 5 案。\n走査の優先度: テストファイルが存在しない主要モジュール → テスト規約（README の Rule 等）との乖離。\n\n#### SubAgent 3: ドキュメント・保守性\n\nドキュメント陳腐化・README と実装の乖離・TODO/FIXME の集積・依存の古さの観点で 5 案。\n走査の優先度: README のテーブルと実装の照合 → TODO/FIXME コメント → 非推奨 API の使用。`,
              `### 3. 結果の集約\n\n3 人の SubAgent から返却された合計 15 案を 1 つのリストにまとめる。\n各候補に以下の情報を含める:\n- タイトル\n- 背景（根拠を織り込んだ 2〜3 文）\n- 具体的な根拠（ファイル・行・症状）\n- 視点（どの SubAgent の案か）\n\n集約結果をセッションディレクトリに \`brainstorm-results.json\` として保存する:\n\n\`\`\`json\n{\n  "candidates": [\n    {\n      "id": 1,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "perspective": "コードの健全性"\n    }\n  ]\n}\n\`\`\``,
            ],
            output: [
              `集約結果を \`brainstorm-results.json\` として保存したこと:\n\n\`\`\`json\n{\n  "candidates": [\n    {\n      "id": 1,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "perspective": "コードの健全性"\n    }\n  ]\n}\n\`\`\``,
            ],
            policy: [
              'repo のファイルを変更しない（読み取り専用）',
              'Issue を起票しない',
              '候補の水増しをしない（各 SubAgent ちょうど 5 案）',
            ],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          }),
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    {
      key: 'dedup_check',
      phase: '重複チェック',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) =>
          buildStepPrompt({
            purpose: ['ブレストで収集した 15 案と既存の open Issue/計画を照合し、重複を除外または注記する。'],
            criteria: [],
            approach: [
              `### 1. brainstorm-results.json の読み込み\n\n${ctx.sessionDir}/brainstorm-results.json から 15 案を読み込む。`,
              `### 2. 既存 Issue/計画の取得\n\n\`\`\`bash\ngh issue list --state open --limit 100 --json number,title,labels\nbun ${join(import.meta.dir, '../mt-plan/list-plans.ts')} draft refined in-progress\n\`\`\``,
              `### 3. 照合・判定\n\n各候補を既存 Issue/計画のタイトルと照合する:\n\n- **同一テーマ**: 候補から除外し、除外理由を記録する\n- **関連テーマ**: 候補に残し「既存 Issue #N に関連」と注記する\n- **無関係**: そのまま候補に残す`,
              `### 4. 結果の保存\n\n重複チェック後の候補リストを ${ctx.sessionDir}/dedup-results.json に保存する:\n\n\`\`\`json\n{\n  "candidates": [\n    {\n      "id": 1,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "perspective": "...",\n      "note": "既存 Issue #N に関連"\n    }\n  ],\n  "excluded": [\n    { "id": 5, "title": "...", "reason": "Issue #N と同一テーマ" }\n  ]\n}\n\`\`\``,
            ],
            output: [
              `重複チェック後の候補リストを \`dedup-results.json\` に保存したこと:\n\n\`\`\`json\n{\n  "candidates": [\n    {\n      "id": 1,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "perspective": "...",\n      "note": "既存 Issue #N に関連"\n    }\n  ],\n  "excluded": [\n    { "id": 5, "title": "...", "reason": "Issue #N と同一テーマ" }\n  ]\n}\n\`\`\``,
            ],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          }),
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    {
      key: 'review_score',
      phase: 'レビュー・採点',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) =>
          buildStepPrompt({
            purpose: ['重複チェック後の候補（最大 15 案）を 3 人のレビュアー SubAgent で並列採点し、上位 5 案を選出する。'],
            criteria: [],
            approach: [
              `### 1. dedup-results.json の読み込み\n\n${ctx.sessionDir}/dedup-results.json から候補リストを読み込む。`,
              `### 2. 3 レビュアー SubAgent 並列起動\n\nTask ツールで 3 人のレビュアーを同一メッセージで並列起動する。\n各レビュアーは自分の観点で全候補を 1〜5 点で採点する。\n\n#### レビュアー 1: 深刻度\n\n「放置した場合のリスク。バグ・パニック・データ損失・保守不能化の可能性」で採点。\n\n#### レビュアー 2: 修正容易性\n\n「少ない変更で改善できるか。大規模リファクタなしで着手できるか」で採点。\n\n#### レビュアー 3: 波及効果\n\n「その修正が他の改善の前提になるか。直すことで連鎖的に良くなるか」で採点。\n\n各レビュアーの返却形式:\n\n\`\`\`json\n{\n  "criterion": "深刻度",\n  "scores": [\n    { "id": 1, "score": 4, "comment": "..." },\n    { "id": 2, "score": 3, "comment": "..." }\n  ]\n}\n\`\`\``,
              `### 3. 集計・選出\n\n3 観点の合計点で降順ソートし、上位 5 案を選出する。\n同点の場合はレビュアーのコメントを添えてユーザーに最終判断を委ねる（present_gate で提示）。`,
              `### 4. 結果の保存\n\n採点結果を ${ctx.sessionDir}/review-results.json に保存する:\n\n\`\`\`json\n{\n  "ranked": [\n    {\n      "id": 3,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "note": "...",\n      "scores": { "深刻度": 4, "修正容易性": 5, "波及効果": 3 },\n      "total": 12,\n      "comments": { "深刻度": "...", "修正容易性": "...", "波及効果": "..." }\n    }\n  ]\n}\n\`\`\``,
              `### 5. present_gate での提示フォーマット\n\npresent_gate では上位 5 案を以下のフォーマットでユーザーに提示する。\n推奨度は合計点から算出: 3-5=★1, 6-7=★2, 8-9=★3, 10-11=★4, 12-15=★5\n\n\`\`\`\n┌─────────────────────────────────────────────────\n│ [1] <タイトル>\n│     推奨度: ★★★★☆\n├─────────────────────────────────────────────────\n│ 💭 背景\n│   <2〜3文の背景説明>\n│\n│ 🔍 根拠\n│   <具体的なファイル・箇所>\n│\n│ ⭐ 推奨理由\n│   <なぜこの推奨度か>\n│\n│ 📊 評価\n│   深刻度: 4 / 修正容易性: 5 / 波及効果: 3 → 合計: 12\n│\n│ 📎 注記\n│   既存 Issue #N に関連（該当時のみ。なければ省略）\n└─────────────────────────────────────────────────\n\`\`\`\n\n提示後に以下を促す:\n\n「起票する候補の番号を教えてください（複数可、例: 1,3,5）。すべて見送る場合は「なし」と入力してください。」`,
            ],
            output: [
              `採点結果を \`review-results.json\` に保存したこと:\n\n\`\`\`json\n{\n  "ranked": [\n    {\n      "id": 3,\n      "title": "...",\n      "background": "...",\n      "evidence": "...",\n      "note": "...",\n      "scores": { "深刻度": 4, "修正容易性": 5, "波及効果": 3 },\n      "total": 12,\n      "comments": { "深刻度": "...", "修正容易性": "...", "波及効果": "..." }\n    }\n  ]\n}\n\`\`\``,
            ],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          }),
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    {
      key: 'present_gate',
      phase: '候補提示',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'abort' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: '選択した', desc: '起票する候補を選択した' },
          { value: 'abort', label: '中断', desc: '起票せず終了する' },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    {
      key: 'create_drafts',
      phase: 'draft 起票',
      type: 'task',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      task: {
        action: 'orchestrate',
        buildPrompt: (ctx: PromptCtx) =>
          buildStepPrompt({
            purpose: ['ユーザーが選択した候補を最小構成の draft Issue として起票する。'],
            criteria: [],
            approach: [
              `### 1. label の確認・自動作成\n\n\`\`\`bash\ngh label create "kind/plan" --repo <owner/repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true\n\`\`\``,
              `### 2. Issue 作成\n\n各選択候補について \`gh issue create\` で起票する。\n\n- **本文はタイトル + \`## 💭 背景\` のみの最小構成**とする。完了条件・方針・ミッションは書かない\n- 背景には走査根拠と企画の意図を自然に織り込む\n- アーキテクチャ深化を含む場合は背景に \`mt-improve-codebase-architecture\` 連携の注記を含める\n- 重複チェックで注記がある場合は背景末尾に \`関連: #N\` を追記する\n\n\`\`\`bash\ngh issue create --repo <owner/repo> \\\n  --title "<タイトル>" \\\n  --body "## 💭 背景\n\n<背景本文（根拠を織り込む）>\n\n## 🐢 履歴\n" \\\n  --label "kind/plan"\n\`\`\``,
              `### 3. Project 追加・Status 設定\n\n\`~/.config/mt-plan/config.json\` から \`projectNumber\`, \`owner\`, \`statusFieldId\`, \`statusOptions.draft\` を読み取り、Project に追加して Status を \`draft\` に設定する。\n\n\`\`\`bash\ngh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json\ngh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>\n\`\`\``,
              `### 4. 報告\n\n起票結果を報告する:\n- 各 Issue の URL、タイトル、Status\n- 起票しなかった候補の一覧\n- 次ステップの案内: 「具体化は \`mt-plan-create\` の from-Issue フローで取り込めます」`,
            ],
            output: ['起票結果（各 Issue の URL・タイトル・Status、起票しなかった候補一覧、次ステップ案内）の報告'],
            policy: ['ユーザーが選択しなかった候補を起票しない', '本文に完了条件・方針・ミッションを含めない'],
            input: [`セッションディレクトリ: ${ctx.sessionDir}`],
          }),
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },

    {
      key: 'confirm_done',
      phase: '完了確認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: 'Done', desc: '完了として終了する' },
          { value: 'abort', label: '中断' },
        ],
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },
  ],
};

export default def;
