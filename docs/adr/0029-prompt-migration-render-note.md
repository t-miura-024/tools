# プロンプト移行レンダリング記録 (grill ステップ代表)

`buildStepPrompt` 移行後の実出力を代表1ステップ (`plan-create` の `grill`) でレンダリングし、固定 H2 順と旧見出しの正規化を記録する。`/tmp` に旧版が残っていないため新旧テキスト diff ではなく、移行後レンダリング + 移行差分 (`git diff`) の旧見出し存在を根拠とする。

## 全移行ステップの移行後レンダリング見出し一覧 (2026-09-15)

手法: 各 `index.ts` の `buildPrompt` を `bun` で実際に呼び出すのは全ステップ分で重いため、見出し一覧は `grep -n "title:"` 等の静的抽出で代替し、代表1ステップ (`plan-create` の `grill`) のみ実レンダリングログ (下記「レンダリング実行ログ」) で裏付ける。`title:` は `Section {title, content}` の H3 見出しとしてレンダリングされる (depth3 自動生成)。旧版との新旧テキスト diff は旧版不在のため不可である。

`buildStepPrompt` 使用件数: `grep -c "buildStepPrompt("` → `plan-create` 7件・`plan-run` 11件・`propose-capabilities` 5件・`propose-quality` 5件・`plan-update` 0件。`plan-update` は `buildStepPrompt` 未使用の raw 文字列 prompt のまま (旧形式 `##` 見出しを直接記述) のため、見出し一覧は `##` / `###` 行の静的抽出で代替する。

### plan-create/index.ts (buildStepPrompt 移行済み)

- `grill`: `1. from-Issue フローの確認` / `2. 徹底ヒアリング` (+ドメインモデリング分岐 `2. 徹底ヒアリング + ドメインモデリング`) / `3. 論点ツリーの最終確認` / `前回の差し戻し` (input 先頭の Section。実レンダリングで `###` になることを検証済み)
- `draft_body`: `1. ヒアリング結果の読み込み` / `2. ドキュメントの整形・埋め込み` / `縦切り分解の検討` / `最終本文の確定`
- `review_body`: `1. 入力の読み込み` / `2. 5観点レビュー` (`A: 追加すり合わせ候補` / `B: 決定間矛盾` / `C: 思想・ポリシー違反＋ADR記載明記` / `D: plan-format準拠性` / `E: 実行可能性・検証可能性`) / `3. 指摘の重み付け` / `4. レビュー結果の書き出し`
- `prepare`: `1. 対象 repo の確認` / `2. label の確認・自動作成` / `3. 分解要否の判定` / `4. 判定結果の書き出し` / `5. 起票案の提示`
- `create_refined`: `1. 入力情報の読み込み` / `2. effort コメントの確定` / `3. Refined Issue の作成または更新` (`3a. from-Issue フロー` / `3b. 新規作成フロー` / `3c. 分解モード`) / `4. Project への追加と refined 化` / `5. Issue 番号の記録`
- `finalize`: `1. Issue 番号の確認` / `2. 作成内容の報告`

### plan-run/index.ts (buildStepPrompt 移行済み)

- `transcribe_docs`: `1. ドキュメントセクションの抽出` / `2. 各ブロックの書き出し` / `3. 書き出し結果の報告`
- `apply_feedback`: `人間ゲートの差し戻し（gateAnswers。原文のまま扱う）` / `手順` (いずれも Section 化済み)
- `execute_work`: `修正ソース（再実行時に適用）` / `1. ミッションの読み取り` / `2. executor SubAgent の起動` / `executor の完了報告契約` / `3. 完了報告の集約` / `Issue body 更新（オーケストレーターが実施）`
- `resolve_effort`: `追加手順（plan-run 固有: Issue body 由来の effort 補完）`

### propose-capabilities/index.ts・propose-quality/index.ts (buildStepPrompt 移行済み。両 WF 同形)

- `brainstorm`: `1. 対象 repo の確認` / `2. 3 SubAgent 並列起動` (SubAgent 1-3) / `3. 結果の集約` / `前回の差し戻し` (input 先頭の Section。capabilities 197行・quality 206行)
- `dedup_check`: `1. brainstorm-results.json の読み込み` / `2. 既存 Issue/計画の取得` / `3. 照合・判定` / `4. 結果の保存`
- `review_score`: `1. dedup-results.json の読み込み` / `2. 3 レビュアー SubAgent 並列起動` (レビュアー 1-3) / `3. 集計・選出` / `4. 結果の保存` / `5. present_gate での提示フォーマット`
- `create_drafts`: `1. label の確認・自動作成` / `2. Issue 作成` / `3. Project 追加・Status 設定` / `4. 報告`

### plan-update/index.ts (buildStepPrompt 未使用。raw 文字列 prompt のまま)

`grep -c "buildStepPrompt("` → 0件。本差分での変更は `reworkFeedbackSection` の行頭 `##` 除去のみ。移行後レンダリング見出しに相当する raw `##` / `###` 行の一覧 (静的抽出):

- `grill`: `## 目的` / `## 入力` / `## 手順` (`### 1. 事実収集` / `### 2. 分析サマリの作成` / `### 3. 徹底ヒアリング` / `### 4. 論点ツリーの最終確認`) / `## 成果物` / `## セッション情報` (旧形式のまま。`## 手順`・`## 成果物`・`## セッション情報` は未正規化)
- `draft_body`: `## 目的` / `## 手順` (`### 1. 入力の読み込み` / `### 2. 最終本文の確定`) / `## 成果物` / `## セッション情報`
- `update_issue`: `## 目的` / `## 手順` (`### 0. 事前ガード` / `### 1. 入力の読み込み` / `### 2. 楽観的ロック` / `### 3. Issue 本文の更新` / `### 4. 変更サマリの投稿` / `### 5. ラベル付与` / `### 6. Issue番号の記録`) / `## 成果物` / `## セッション情報`
- `report`: `## 目的` / `## 手順` (`### 1. レポート生成` / `### 2. 完了報告`) / `## 成果物` / `## セッション情報` (+ `## 走査サマリ` / `## 前提崩れ一覧` / `## grill 決定ログ` / `## 更新差分サマリ` / `## 次アクション` の出力雛形行)
- `judge_analysis` / `judge_update`: `## 目的` / `## 指示` / `## セッション情報` (判定用 raw prompt)

## 固定 H2 順

`tado/src/prompt.ts` の `SECTION_ORDER` (96-103行) が順序を定義する:

`purpose` → `## 目的` → `criteria` → `## 完了条件` → `approach` → `## 方針` → `output` → `## 出力` → `policy` → `## 注意事項` → `input` → `## インプット`

すなわち固定順は **目的 → 完了条件 → 方針 → 出力 → 注意事項 → インプット** である。空 (または未指定) のセクションは出力に含めない (`buildStepPrompt` 132-137行)。grill ステップは `criteria: []`・`policy` なしのため、実出力は `## 目的 → ## 方針 → ## 出力 → ## インプット` となる (下記ログ参照)。

## 旧見出しの正規化マップ

移行差分 (`git diff`) で削除された旧見出し行と移行先の対応 (grill ステップ実例。`plan-run` 差分でも `## 手順` 4件・`## セッション情報` 3件の削除を確認):

| 旧見出し            | 移行先                                                   | 備考                                                                       |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `## 目的`           | `## 目的` (`purpose`)                                    | 維持                                                                       |
| `## 手順`           | `## 方針` (`approach`)                                   | 改名。配下の `###` は `Section` の `{title, content}` へ (depth3 自動生成) |
| `## 成果物`         | `## 出力` (`output`)                                     | 改名                                                                       |
| `## セッション情報` | 削除 (`input` の `セッションディレクトリ:` 行へ折り込み) | `## インプット` 配下の1行に縮退                                            |

## レンダリング実行ログ

実コードの `buildPrompt` を `bun` で直接呼び出した (`chezmoi/dot_tado/workflows/plan-create/index.ts` の `review_cycle` > `grill`。`sessionDir=/tmp/grill-real/session`、`repo-info.json` は非 t-miura-024 の `withDocs=false` 系、初回実行):

````text
## 目的

計画の全側面についてユーザーと共通理解に達するまでヒアリングを行う（Grill Phase）。

## 方針

### 1. from-Issue フローの確認

ユーザーに「既存 Issue を取り込みますか？」と確認する。
- Yes の場合: `gh issue view <number> --json title,body,labels,state` で Issue メタデータを取得し、ヒアリングの素材として使う
- No の場合: 新規計画としてヒアリングを開始する
### 2. 徹底ヒアリング

mt-grill スキル（.../mt-grill/SKILL.md）をロードし、その指示に従ってヒアリングを行う。
ヒアリングは mt-grill の方式に従って進める:
- 各ラウンドでフロンティア（前提がすべて確定済みの決定）の質問全体をまとめて提示し、ユーザーの回答を待ってから次のラウンドに進む
- 回答を受けて論点ツリーを更新し、フロンティアを再計算し、次のラウンドを提示する
- フロンティアが空になり、ユーザーが共通理解を確認するまでラウンドを継続する

### 3. 論点ツリーの最終確認

ヒアリングの全決定が論点ツリー上で確定していることを確認する。
質疑ログなどの別ファイルは残さない。

## 出力

成果物なし。中間ファイルは残さない。確定内容は次段 draft-body で `issue-body.md` に集約する。
````

## インプット

### 前回の差し戻し

前回の差し戻し (gate:review_gate):

- (なし。初回実行)

セッションディレクトリ: /tmp/grill-real/session
---HEADINGS---

## 目的

## 方針

### 1. from-Issue フローの確認

### 2. 徹底ヒアリング

### 3. 論点ツリーの最終確認

## 出力

## インプット

### 前回の差し戻し

```

確認事項:

- H2 出現順は `## 目的 → ## 方針 → ## 出力 → ## インプット` で固定順と一致 (`criteria` 空のため `## 完了条件` は省略、`policy` なしのため `## 注意事項` は省略)。
- `###` は `Section` (`{title, content}`) 由来のみで、手動 `###` 文字列はソースに残っていない。
- `前回の差し戻し` は Section 化済み (H3 以下)。呼び出し側 (`plan-create/index.ts` 603-609行) が `Section {title: "前回の差し戻し", content: reworkFeedbackSection(...)}` で包み `input` 先頭に配置するため、実レンダリングでは `## インプット` 配下の `### 前回の差し戻し` として出力され、固定 H2 順外の5つ目の H2 としては出現しない (上記 `---HEADINGS---` ログで検証済み。2026-09-15 `bun` 実実行)。
- `reworkFeedbackSection` 自体の戻り値は行頭 `#` を含まない動的 string のままであり、素通し raw 出力の問題は呼び出し側の Section 化で解消している。`plan-update/index.ts` (328・627行) は raw 文字列 prompt のため Section 化不可であり、行頭 `##` 除去の軽微修正のみで対応 (本差分に含む)。

## chezmoi 適用検証 (読み取りのみ。2026-09-15)

`chezmoi apply` は実行していない (未適用)。読み取りのみの確認結果:

- `chezmoi source-path` → `/Users/mt/src/tools/chezmoi`。本差分の作業場所 (`/Users/mt/src/tools-wt-1/chezmoi`) とは別パスのため、worktree の未コミット変更は `chezmoi diff` に反映されない。
- `chezmoi diff` → 出力 0 行 (exit 0)。worktree 変更に対応する差分は表示されない (上記理由)。
- `chezmoi status` → 出力なし。
- 読み取り専用の到達確認として `diff -rq <worktree>/chezmoi/dot_tado/workflows ~/.tado/workflows` を実行 (`~/.tado` への書き込みなし) → 以下4ファイルが差分あり (`Only in ... node_modules` の3行を除く):
  - `plan-create/index.ts`
  - `plan-run/index.ts`
  - `propose-capabilities/index.ts`
  - `propose-quality/index.ts`
  - すなわち worktree の移行内容は `~/.tado` へ未反映であり、`chezmoi apply` 相当の適用は本セッションでは行わない。
```
