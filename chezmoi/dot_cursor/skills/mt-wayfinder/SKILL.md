---
name: mt-wayfinder
description: 1 セッションに収まらない大きな企画を、決定チケットの共有マップとして分解し、1 つずつ解いて道筋を明らかにする。wayfinder、決定マップ、巨大企画の分解と言われた時に使用する。
---

# Wayfinder

大きく不確実な企画を、実行チケットではなく **決定チケット** のマップとして扱う。目的は成果物の完成ではなく、進む道を明らかにすること。

## 🧠 前提知識

- 既定は計画のみ。実行はマップの Notes で明示された場合だけ持ち込む
- チケットは質問であり、解決は決定である
- マップは索引、詳細は各チケットに置く
- 人間が読む文では Issue 番号ではなくタイトルで参照する
- このリポジトリでは GitHub Issue + Project を使う（`mt-create-plan` と同系統）

## チケット種別

| 種別 | 誰が動くか | 用途 |
| --- | --- | --- |
| `research` | エージェント単独可 | 一次資料の事実を集め、決定の前提を固める |
| `grilling` | 人間必須 | 方針・優先度・トレードオフを 1 問ずつ詰める |
| `prototype` | 人間必須 | 安い具体物で「どう見える/動くか」を確かめる |
| `task` | どちらか | 決定の前に必要な手作業（権限取得、データ移動など） |

ラベルは `wayfinder:research` / `wayfinder:grilling` / `wayfinder:prototype` / `wayfinder:task` を使う。マップ本体は `wayfinder:map`。

## 🏃 ステップ

### A. マップを起こす

#### A1. Destination を確定する

1. `mt-grill-me` または `mt-grill-with-docs` で、このマップが辿り着く状態を 1〜2 文に固定する
2. Destination は仕様・決定・変更のいずれでもよいが、「何ができたら道が開いたか」が判定可能であること
3. スコープ外の作業を先に切り、Out of scope 候補としてメモする

#### A2. 幅優先で frontier を洗う

1. 1 本を深く掘らず、全体を横断して「今言える決定」と「まだ霞」を分ける
2. 道がすでに見えている、または 1 セッションで足りるならマップを作らず `mt-create-plan` 等へ戻す
3. 霞（Not yet specified）は粗く書く。まだチケット化しない

#### A3. マップ Issue を作る

```bash
# label がなければ作成（冪等）
gh label create wayfinder:map --color BFD4F2 --description "Wayfinder map" 2>/dev/null || true

gh issue create \
  --title "<Destination を短く表すタイトル>" \
  --label wayfinder:map \
  --body-file <map-body.md>
```

マップ本文テンプレート:

```markdown
## Destination

<このマップが辿り着く状態。1〜2 文。>

## Notes

- ドメイン:
- 毎回参照する Skill:
- この努力の立ち位置（計画のみ / 実行も含む）:

## Decisions so far

<!-- close したチケットだけ。詳細はチケット側。ここは 1 行 gist + リンク -->

## Not yet specified

<!-- 言えるほど鋭くないが、Destination 方向にある霞 -->

## Out of scope

<!-- Destination の外。卒業しない -->
```

#### A4. 今言えるチケットだけを子 Issue にする

1. 質問がすでに鋭いものだけをチケット化する
2. 1 チケット = 1 エージェントセッション程度の大きさ
3. 本文は Question のみ。答えは resolution 時にコメントする

```bash
gh label create wayfinder:grilling --color 0E8A16 --description "Wayfinder grilling ticket" 2>/dev/null || true
# research / prototype / task も同様

gh issue create \
  --title "<決定の名前>" \
  --label wayfinder:grilling \
  --body "## Question

<このチケットが解く決定または調査>"
```

チケット本文:

```markdown
## Question

<このチケットが解く決定または調査>
```

#### A5. 依存を後から結ぶ

1. チケットに番号が付いてから blocking を張る
2. GitHub では本文の `Blocked by` にタイトルリンクを書く（ネイティブ依存が使えるならそれを優先）
3. frontier = open かつ blocker がすべて close かつ unassigned

#### A6. research だけ並列起動して止める

1. 作った `research` チケットを claim し、調査を並列起動する
2. 結果はチケットへ解決コメントとして残す
3. charting セッションでは hand-resolve しない（research を除く）

### B. マップを進める

1. マップ本文を読む（全チケット本文は読まない）
2. ユーザー指定がなければ frontier の先頭を選ぶ
3. `gh issue edit <n> --add-assignee @me` で claim する（作業前に必ず）
4. 種別に応じて 1 件だけ解く
   - research: 一次資料調査
   - grilling: `mt-grill-me` / `mt-grill-with-docs`
   - prototype: 安い具体物を作り反応を取る
   - task: チェックリストを実行または人間へ渡す
5. 解決コメントを残して close する
6. マップの Decisions so far に 1 行追加する: `- [<title>](url) — <gist>`
7. 答えで鋭くなった霞をチケット化し、Not yet specified から除く
8. Destination 外だと分かったチケットは close し、Out of scope へ移す

## ✅ 完了条件

### マップ起こし

- Destination が判定可能な文になっている
- マップ Issue（`wayfinder:map`）がある
- frontier に取れるチケットが 1 件以上ある、または Not yet specified に霞が残っている
- 1 セッションで hand-resolve した決定は 0 件（research を除く）

### マップ進行

- claim → 解決 → close → Decisions so far 追記まで完了している
- 1 セッションで解いた決定は 1 件である（research の並列を除く）

## ⚠️ 注意事項

- 実行計画の分解は `mt-create-plan` の責務
- 決定が尽きたらマップを終え、実行へ渡す
- 番号だけの参照で人間向け文を書かない
- 霞を先回りして細かく切らない
