# tsconfig は tado 側が base 提供し actual は scaffold 生成とする

ワークフロー作者が `Section` 型の恩恵（行頭 `#` の型レベル拒否）を受けるには、tado の型解決を伴う `tsc --noEmit` の土台が必要であり、これを全利用者が自前で用意するのは重複である。そこで `tsconfig.base.json` を tado package に同梱して `exports`（`./tsconfig.base`）で提供し、actual は `tado install` が一度だけ雛形生成（scaffold）する。生成後の所有は利用者とし、install は既存 actual に不干渉とする。

Considered Options: 利用者側完結（他利用者との重複が残る）、install 継続所有（カスタム余地と更新の衝突）、ファイルレス `tado check`（新規実装が重い）。

## 追記: deep-research 移行済み確認 (2026-09-15)

`chezmoi/dot_tado/workflows/deep-research/index.ts` が Section 型 (`buildStepPrompt`) へ移行済みであることを再確認した。既存コミット済みのため本差分には含まれない。

検証コマンドと結果 (2026-09-15 実施):

- `grep -c "buildStepPrompt(" chezmoi/dot_tado/workflows/deep-research/index.ts` → `12` (呼び出し12件。`import { buildStepPrompt }` 行は `buildStepPrompt(` を含まないため計数対象外)
- `grep "^### " chezmoi/dot_tado/workflows/deep-research/index.ts | wc -l` → `0` (手動 `###` 見出しなし。`###` は `Section` の `{title, content}` が depth3 から自動生成する)
- `grep "## セッション情報" chezmoi/dot_tado/workflows/deep-research/index.ts | wc -l` → `0` (旧 `## セッション情報` は撤去済み。セッション由来値は `input` の `セッションディレクトリ:` 行へ移行)
- 参考: `grep "## 手順" ... | wc -l` → `0`、`grep "## 成果物" ... | wc -l` → `0` (旧見出しは `## 方針` / `## 出力` へ正規化済み)

## スコープ境界 (2026-09-15)

本差分 (未コミット) に含まれるファイルは以下に限る:

- `CONTEXT.md` (tado Section 移行の用語追加)
- `chezmoi/dot_tado/workflows/plan-create/index.ts`
- `chezmoi/dot_tado/workflows/plan-run/index.ts`
- `chezmoi/dot_tado/workflows/plan-update/index.ts` (差し戻し行の軽微修正のみ。`reworkFeedbackSection` の行頭 `##` 除去。`buildStepPrompt` 未使用の raw 文字列 prompt のため Section 化は不可)
- `chezmoi/dot_tado/workflows/propose-capabilities/index.ts`
- `chezmoi/dot_tado/workflows/propose-quality/index.ts`
- `chezmoi/dot_tado/tsconfig.json` (新規。`extends: tado/tsconfig.base`)
- `docs/adr/0028-tado-tsconfig-scaffold.md` (本ファイル。新規)
- `docs/adr/0029-prompt-migration-render-note.md` (新規。grill ステップのレンダリング記録)

tado 側の作業 (別リポジトリ tado-wt-1: `tsconfig.base.json` 同梱・`exports` の `./tsconfig.base` 提供・`Section` / `buildStepPrompt` 本体) は本差分に含まれない。本差分は tools 側の利用 (移行4WF + scaffold 受け皿 + 記録) のみであり、tado 本体の変更は別差分として扱う。
