---
name: mt-propose-capabilities
description: 対象 repo を軽量走査して Capability 軸（新しい能力の獲得）の企画候補を 5〜8 個提示し、ユーザーが選んだ候補を最小構成の draft Issue として起票する。企画の発掘・種まき、capability 提案、アイデア出しと言われた時に使用する。
---

# mt-propose-capabilities

対象 repo の軽量走査から Capability 軸（新しい能力の獲得）の企画候補を抽出し、ユーザーの選択を経て draft Issue として起票する。企画の発掘に終始し、起票後の具体化（完了条件・方針・実行単位の策定）は `mt-create-plan` の from-Issue フローに委譲する。

## 共有資材

`~/.config/opencode/skills/mt-plan/` 配下の以下を参照する:

- `list-plans.ts` — 既存計画 Issue の一覧取得（重複チェックに使用）
- `init-config.ts` — 設定読み込み

`~/.config/mt-plan/config.json` が存在しない場合は `mt-plan init` を案内して中断する。

## 🏃 ステップ

### 1. 走査フェーズ

対象 repo を軽量に読み取り、Capability 軸の企画候補を抽出する。

#### 1a. 対象 repo の確認

`gh repo view --json nameWithOwner` で repo を確認する。

#### 1b. 軽量走査

以下を **読み取り専用** で走査する。コードの詳細な解析は行わず、構造と意図の把握に留める。

| 走査対象 | 確認する観点 |
|----------|-------------|
| `README.md`（または `README`） | プロジェクトの目的・提供機能・今後の方向性 |
| ディレクトリ構造（上位 2 階層） | モジュール構成、未整備な領域、拡張の余地 |
| マニフェスト（`package.json`, `Brewfile`, `mise.toml`, `Cargo.toml` 等） | 依存関係、未活用なツール、追加可能な連携 |
| `docs/` 配下（存在すれば） | ドキュメント整備状況、未記載の機能・制約 |
| 既存スキル・設定定義（`skills/`, `agents/`, `.opencode/` 等） | 既存能力の棚卸し、抜け落ちているワークフロー |
| `git log --oneline -20` | 最近の開発傾向、活発な領域 |

#### 1c. 候補の抽出

走査結果から「この repo に新しい能力を追加するとしたら何か」の観点で候補を抽出する。

- 自信のあるものだけを **5〜8 個** に厳選する。量より質を優先し、下位案で水増ししない
- 各候補に「タイトル」「背景（なぜその能力が有用か）」「走査根拠（どの走査結果から導いたか）」を付ける
- 既存の仕組みで既にカバーされている能力は候補にしない
- アーキテクチャ深化のような重いテーマは、背景に `mt-improve-codebase-architecture` への連携を示唆する一文を添える

### 2. 重複チェックフェーズ

既存の open Issue・計画と照合し、重複を除外または注記する。

1. `gh issue list --state open --limit 50 --json number,title` で open Issue を取得
2. `bun ~/.config/opencode/skills/mt-plan/list-plans.ts draft refined in-progress` で既存計画を取得
3. 各候補を既存 Issue/計画のタイトルと照合する:
   - **同一テーマ**: 候補から除外し、除外理由をユーザーに報告する
   - **関連テーマ**: 候補に残し「既存 Issue #N に関連」と注記する
   - **無関係**: そのまま候補に残す

### 3. 候補提示フェーズ（Human Gate）

ユーザーに候補一覧を提示し、選択を求める。**ユーザーが選択するまで起票しない。**

提示フォーマット:

```
 Capability 企画候補（対象: <repo名>）

 1. <タイトル>
    背景: <なぜ有用か>
    根拠: <走査根拠>
    [注記: 既存 Issue #N に関連]（該当時のみ）

 2. ...

 起票する候補の番号を教えてください（複数可、例: 1,3,5）。
 すべて見送る場合は「なし」と入力してください。
```

- ユーザーが番号で選択 → 選択された候補だけ起票する
- ユーザーが「なし」→ 起票せず終了する
- 無選択の自動量産はしない

### 4. draft 起票フェーズ

選択された候補を最小構成の draft Issue として起票する。

#### 4a. label の確認・自動作成

`kind/plan` label が対象 repo に存在しない場合は自動作成する（冪等）。

```bash
gh label create kind/plan --repo <owner>/<repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true
```

#### 4b. Issue 作成

各選択候補について `gh issue create` で起票する。

- **本文はタイトル + `## 💭 背景` のみの最小構成**とする。完了条件・方針・実行単位は書かない
- 背景には走査根拠と企画の意図を書く
- 重複チェックで注記がある場合は背景末尾に `関連: #N` を追記する

```bash
gh issue create --repo <owner>/<repo> \
  --title "<タイトル>" \
  --body "## 💭 背景

<背景本文>

## 🐢 履歴
" \
  --label "kind/plan"
```

#### 4c. Project 追加・Status 設定

`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。

```bash
# Project に追加（itemId を取得）
gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json

# Status を draft に設定
gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>
```

#### 4d. 報告

起票結果を報告する:

- 各 Issue の URL、タイトル、Status
- 起票しなかった候補（ユーザーが選択しなかったもの）の一覧
- 次ステップの案内: 「具体化は `mt-create-plan` の from-Issue フローで取り込めます」

## ✅ 完了条件

- 対象 repo の軽量走査から Capability 軸の企画候補が 5〜8 個抽出されている
- 既存 open Issue/計画との重複チェックが行われ、重複の除外または注記がされている
- ユーザーが候補一覧を見て採否を選択している（Human Gate）
- 選択された候補がタイトル + 💭 背景のみの最小構成で draft Issue として起票されている
- 起票された Issue に `kind/plan` label が付与され、plans Project に追加され、Status が `draft` に設定されている
- 起票結果と次ステップ（mt-create-plan from-Issue フロー）が報告されている

## 📦 アウトプット

- 起票された draft Issue（GitHub URL）
- 候補一覧と選択結果の報告

## ⚠️ 注意事項

- 企画の具体化（完了条件・方針・実行単位の策定）はこの Skill の責務ではない。`mt-create-plan` に委譲する
- 走査は読み取り専用で行い、repo のファイルを変更しない
- 候補は 5〜8 個に厳選する。8 個を超える場合は上位を絞り、5 個に満たない場合は無理に水増ししない
- ユーザーの選択前に Issue を起票しない
- `~/.config/mt-plan/config.json` が未設定の場合は `mt-plan init` を案内して中断する
- 重複チェックは毎回実行する。定期実行でノイズが増えないようにする
- `kind/plan` label の自動作成は冪等に行う
