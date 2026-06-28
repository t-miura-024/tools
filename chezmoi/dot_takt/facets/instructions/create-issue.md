Grill Phase で蓄積した対話内容をもとに、plan-format.md に従って GitHub Issue body を生成し、Issue を作成する。

## 手順

1. `{user_inputs}` に蓄積された Grill Phase の全対話を読み、各セクションに振り分ける。
2. `knowledge/plan-format.md` のセクション定義と運用ルールに従って Issue body を組み立てる。
3. `output-contracts/plan.md` のテンプレートに従って body を出力する。
4. `gh repo view --json nameWithOwner` で現在ディレクトリの repo を確認する。
5. 対象 repo を決定する:
   - repo の owner が `t-miura-024` → その repo をそのまま使用。
   - それ以外 → `t-miura-024/note` を対象 repo とし、`external/[repo-name]` label を付与。
6. 対象 repo に `kind/plan` label が存在するか確認し、存在しない場合は自動作成する。
   ```bash
   gh label list --repo <target-repo> --json name --jq '.[].name' | grep -q '^kind/plan$' || \
   gh label create kind/plan --repo <target-repo> --description "mt-plan で管理する計画 Issue" --color "0E8A16"
   ```
7. `external/[repo-name]` label が必要な場合も同様に確認・自動作成する。
8. `{task}` に既存 Issue の内容が含まれる場合（from-Issue フロー）:
   - 変更プレビューを表示し、ユーザーに y/n 確認を求める。
   - `gh issue edit` で既存 Issue を更新する。
   - `--add-label` で `kind/plan`（と必要に応じて `external/<repo-name>`）を追加。
9. 新規作成の場合:
   - `gh issue create` で Issue を作成する。
   - `--project` フラグには `~/.config/mt-plan/config.json` の `projectNumber` を指定する。
   ```bash
   gh issue create \
     --repo <target-repo> \
     --title "<計画タイトル>" \
     --body-file <body-file> \
     --label "kind/plan" \
     --project "<project-number>"
   ```
10. Project 追加後、Status を `draft` に設定する（`~/.config/mt-plan/config.json` の `statusOptions.draft` を使用）。

## 前提確認

- `~/.config/mt-plan/config.json` が存在しない場合は、`bun ~/.takt/scripts/init-config.ts --owner <owner> --project <number>` の実行を案内して ABORT する。

## 出力

作成された Issue の URL・番号、対象 repo、Project URL、現在の Status（draft）を報告する。
