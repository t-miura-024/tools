---
status: accepted
---

# mt-review-diff の指摘を差分内の `+` 行のみに限定する

## 背景 (Context)

`mt-review-diff` は差分を敵対的に検証するワークフローであるが、検証者（`mt-review-diff-reviewer` SubAgent）が `edit:deny / bash:deny` ながら `read` は自由であったため、差分に含まれないファイル・行への指摘が混入し、hunk コメントのノイズとなっていた。`collect_context` が生成する `diff.txt`（`base...HEAD + unstaged + untracked`）が SoT であるにもかかわらず、プロンプトにも機械的検証にも「差分外禁止」の規律がなく、位置情報（`filePath` / `position`）も任意（`general` 許容、`side:old` 許容）であった。

観点プール 15 観点のうち `logic-3 影響範囲` は定義上「同種問題を抱える他箇所（横展開）」を誘発し、`arch-1〜5` も差分外の設計論に触れがちで、差分外指摘を助長していた。差分外指摘は hunk 上での可視性・解決運用を複雑にし、人間レビューの負荷を上げるため、明確に禁止する必要が生じた。

## 決定 (Decision)

`mt-review-diff` の指摘は `diff.txt` の `+` 行（追加/変更行）のみに限定し、機械的フィルタとプロンプト強化の二重防御で強制することとした。

- **SoT**: `diff.txt` を唯一の SoT とする。`get-branch-diff.ts` 等との二重管理は行わない。
- **粒度**: 行単位（厳格） — `+` 行のみ許容。hunk コンテキスト行（` ` 3行）は含めない。ファイル単位の許容は行わない。
- **読み取り vs 指摘**: 読み取りは自由、出力（`findings` / hunk コメント）のみを差分内に制限する。文脈理解のための read は許容する。
- **強制**: プロンプト強化 + `publish_findings` での機械的フィルタの複合。`_shared/mt-review-helpers.ts` に純粋関数 `parseDiffChangedLines(diffRaw): Map<file, Set<addedLines>>` と `filterFindingsByDiff(findings, map): {kept, filteredOut}` を追加し、`diff --git` / `+++ b/<path>` / `@@` の new側カウントで `+` 行を抽出する。削除ファイル（`+++ /dev/null`）、バイナリ（`Binary files`）、リネームは新パス（`+++ b/<new>`）のみを対象とする。
- **位置情報**: `filePath` 必須、`position: {side:"new", line}` 必須（line は `+` 行の行番号）。`general`（ファイルなし）/ `side:"old"` / `position` なしは禁止。後方互換のフォールバック（`general` → `newLine:1` 合成）は AGENTS.md 方針に従い削除する。
- **除外の透明性**: 除外は `filteredOut: {count, items:[{axis,filePath,line,reason,detail}]}`（`reason`: `missing_filePath` / `missing_position` / `old_side` / `file_not_in_diff` / `line_not_in_added`）として `findings.json` の任意フィールドに記録し、counts は除外後の kept で再計算する。`validateFindingsJson` は `filePath` / `position` / `side:"new"` を必須として検証する。
- **例外**: 差分起因で差分外が確実に壊れる場合でも、差分内の原因行に紐付けて記述し、差分外ファイルへの直接 `filePath` は行わない。読み取りは自由だが指摘位置は差分内に留める。
- **観点プール**: 15 観点は維持し、`logic-3` と `arch-1〜5` の要約を「差分内の原因行に紐付けて指摘。差分外ファイルへの直接指摘は行わない」に書き換える。Tier/width/depth の決定論的写像は変更しない。
- **実装範囲**: `workflows/mt-review-diff/index.ts`（`run_reviewers` / `publish_findings` プロンプト）、`_shared/mt-review-helpers.ts`（純粋関数・validate・buildHunkComments）、`agents/mt-review-diff-reviewer.md`（3箇所同期）、本 ADR。

## 代替案 (Considered Options)

- プロンプト強化のみで抑止する方式: 実装コストは最小だが LLM の遵守は確率的で、今回の「発生している」事象を再発防止できないため不採用。機械的フィルタとの複合を選択した。
- ファイル単位で許容する方式（diffに含まれるファイルならどの行でも可）: 実装は `Set<filePath>` のみで簡素だが、差分ファイル内の無関係行への指摘が残り、ノイズ削減効果が薄いため不採用。行単位（厳格）を選択した。
- `validateFindingsJson` でエラー停止させる方式（差分外が1件でもあれば fail）: 確実だが1件の逸脱でレビュー全体が停止し可用性を損なうため不採用。除外 + 透明通知 + counts再計算を選択した。
- 観点 `logic-3` / `arch-*` を廃止・統合する方式: 15 観点の Tier 設計と width/depth 写像が崩れ、既存 effort との互換性が壊れるため不採用。要約を「差分内限定」に書き換える方式を選択した。
- `get-branch-diff.ts` の `files` / `rawDiff` を SoT にする方式: merge-base 経由で正確だが、二つの差分生成ロジックの差異管理が複雑になるため不採用。既存 SoT である `diff.txt` を選択した。

## 帰結 (Consequences)

- `findings.json` の全指摘は `filePath` と `side:"new"` の `+` 行に紐付き、hunk コメントは全て新コード上で可視化・解決可能になる。`general` / `old` への指摘は機械的に除外され、差分外ノイズが消失する。
- `filteredOut` により除外理由が透明に追跡可能になり、検証者の差分外指摘の傾向を機械的に分析できる。counts は除外後で厳密に一致するため、ゲート判定（must/should ブロック）の信頼性が上がる。
- `parseDiffChangedLines` / `filterFindingsByDiff` は純粋関数として `bun:test` で回帰テスト可能になり、diff 形式（リネーム・削除・バイナリ・untracked）の境界ケースが担保される。
- 観点プールの 15 観点・Tier・width/depth 写像は維持されるため、既存の effort 指定（`width=medium depth=medium` 等）は互換性を保つ。`logic-3` / `arch-*` の差分外設計論は差分内の原因行に紐付ける運用に正規化される。
- 後方互換の `general` フォールバックと `filePath` / `position` 任意のコードパスは削除され、AGENTS.md 方針に準拠した最もシンプルな実装になる。既存セッションの `findings.json` に旧形式（`filePath` なし等）が含まれる場合は `validateFindingsJson` で invalid となり、除外対象として再生成が必要になる。
