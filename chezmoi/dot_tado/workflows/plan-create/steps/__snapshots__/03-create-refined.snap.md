## 目的

review-gate で承認された Issue body を使って Refined Issue を直接作成（または更新）する。
コンテンツ生成は行わず、effort コメント確定と GitHub 操作のみに専念する。
承認前の作成はしない（本ステップは review-gate 通過後のみ実行される）。

## 完了条件

承認済み body で Refined Issue の作成（または更新）が完了し、番号が `issue-number.txt`（子は `issue-number-<n>.txt`）に記録されている
Project への追加と refined 遷移が完了している

## 方針

### 1. 入力情報の読み込み

分解モードで子 body（`issue-body-<n>.md`）が存在するのに `review-body.md` に子への言及（`issue-body-<n>.md` の記載）がない場合は子未レビューのため GitHub 操作へ進むな。escalate し、失敗報告のみ行うこと。
セッションディレクトリの `issue-body.md` と `prepare-decision.json` と `review-body.md` を読み込む。
分解モードの場合は `issue-body-<n>.md` も `ls issue-body-*.md` で全件検出して読み込む。
prepare-decision.json から mode / fromIssue / issueNumber / repo を確認する。
review-body.md の 🚨 must 有無を確認する。must が残るまま本ステップに到達した場合は判断漏れのため GitHub 操作へ進まず escalate する（create-refined の check が must 残存で fail し onFail escalate となる。tado 上で review-gate の request_changes を選び grill に戻って再生成すること）。ただし review-cycle-exhausted.json の valid マーカーがある枯渇経由（review-exhausted の approve）の場合は警告として記録し作成へ進む（check が警告付きで後続へ進む）。body の再生成はしない（修正は request_changes→grill 経由の再生成に一本化）。
### 2. effort コメントの確定

各ファイル末尾の `<!-- effort: width=... depth=... -->` コメント（draft-body が書き出した初期値を決定値とする）を維持し、形式検証のみ行う。各ファイルで既存 `<!-- effort:.*?-->` を `/<!-- effort:.*?-->/` で置換せず、そのまま残す。コメントが欠落している場合のみ末尾に追記する（冪等）。分解モードでは `ls issue-body-*.md 2>/dev/null` で全件検出し各ファイルで同様に確認する。新規作成フローでは Issue 作成前のため `gh issue edit` は不要だが、from-Issue フロー・リトライ更新パスでは後段 §3 の `gh issue edit` で effort 反映済み body を更新すること。
このコメントは plan-run の parseEffortFromIssueBody が読み取るため形式は厳守する。更新後は `grep -E "<!-- effort: width=(low|medium|high|xhigh|max) depth=(low|medium|high|xhigh|max) -->" issue-body.md`（分解モードでは `issue-body-*.md` の各件も対象にして）で検証する。不一致・欠落があればコメントを修正して再検証するループを繰り返し、それでも一致しなければ escalate して GitHub 作成へ進まない（失敗報告し、作成コマンドを実行しない）。
### 3. Refined Issue の作成または更新

セッションディレクトリに issue-number.txt が存在する場合（リトライ時）は、既存 Issue を `gh issue edit` で更新し、新規作成はしない（冪等ガード）。
存在しない場合は新規作成する。
分解モードで子 Issue の作成まで進んで失敗した場合は、作成済みの子は再作成せず既存番号を使い、未作成の子のみ作成する。部分失敗時の再実行は issue-number.txt を起点に本ステップから再開する（finalize から再開しない）。

**番号検証（必須）:** `gh issue edit` / `plan-transition-plan.ts` に渡す番号は、必ずセッションディレクトリ内の `issue-number.txt` と `issue-number-<n>.txt` の全件から読み取った値のみ使う。LLM が記憶・推測した番号を直接埋め込まない。使う前に全件の数字形式を検証し（例: `for f in ${ctx.sessionDir}/issue-number.txt ${ctx.sessionDir}/issue-number-*.txt; do [ -f "$f" ] || continue; grep -Eq '^[0-9]+$' "$f" || echo "NG: $f"; done`）、1件でも不一致・空・欠落があれば GitHub 操作へ進まず escalate する。シェルに渡すパスはセッションディレクトリ配下の絶対パスで指定し、クォートする。

#### 3a. from-Issue フロー（既存 Issue を更新）

```bash
gh issue edit <number> --body-file <SESSION>/issue-body.md
```

**重要:** 新規作成せず、必ず既存 Issue を更新すること。

#### 3b. 新規作成フロー（mode: update）

```bash
gh issue create --title "<title>" --body-file <SESSION>/issue-body.md --label "kind/plan"
```

#### 3c. 分解モード（mode: decompose）

親 Issue を作成（または from-Issue の場合は更新）した後、各子計画について Issue を作成する（親子すべて `kind/plan` label。旧文言の draft 要素は意図的に廃止し `kind/plan` のみ付与する仕様）:

```bash
gh issue create --title "<子タイトル>" --body-file <SESSION>/issue-body-<n>.md --label "kind/plan"
```

GitHub REST API で親子関係を設定する:

```bash
gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \
  -f sub_issue_id=<child-issue-id>
```
### 4. Project への追加と refined 化

Issue（分解モードの場合は親子すべて）を GitHub Project に追加する:

```bash
gh project item-add <project-number> --owner <owner> --url <issue-url>
```

続けて refined に遷移する（Status 更新 + `## 🐢 履歴` へ遷移エントリ追記）。`<number>` には §3 の番号検証を通過した `issue-number.txt` と `issue-number-<n>.txt` の全件の値のみ使う（未検証の番号を渡さない）:

```bash
bun run <REPO>/chezmoi/dot_tado/workflows/shared/plan-transition-plan/main.ts <number> refined
```

分解モードの場合は子 Issue すべてと親 Issue について実行し、親子すべてを refined にする。
### 5. Issue 番号の記録

§3 で Issue を1件作成するごとに直ちに `issue-number.txt`（子は `issue-number-<n>.txt`）へ記録し、§4 に進む前に全件の記録を完了する（作成と記録の間隔を空けず、再実行時の重複作成を防ぐ）。

## 出力

report 時の `artifacts` に以下を含める:
```json
{"key": "issue-number.txt", "path": "<SESSION>/issue-number.txt"}
```

## 注意事項

未レビュー子の refined 化を禁止する。分解モードで子 body が存在するのに review-body.md に子への言及（`issue-body-<n>.md` の記載）がない場合は子未レビューのため GitHub 操作を行うな。escalate し、失敗報告のみ行うこと

## インプット

セッションディレクトリ: <SESSION>
