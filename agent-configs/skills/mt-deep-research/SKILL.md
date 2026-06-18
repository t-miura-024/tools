---
name: mt-deep-research
description: ローカル SearXNG、curl、pandoc、jq を使い、Planner/Researcher/Writer/Reviewer の SubAgent オーケストレーションで自律的な多段探索（Deep Research）を行う。Researcher は Planner が提示する主要な問いごとに、Reviewer はレビュー観点ごとに並列化する。調査の制約・スコープのヒアリングは省略し、Planner が計画書で提案する。最終レポートは tmp/research/yyyymmdd-[topic]/report.md に出力する。
---

# mt-deep-research

ローカル SearXNG インスタンス、`curl`、`pandoc`、`jq` を使い、**Planner / Researcher / Writer / Reviewer** の 4 つの SubAgent をオーケストレーションして、自律的な多段探索（Deep Research）を行う。

調査開始前にユーザーから背景・目的・前提知識を引き出し、Planner が軽い事前調査をもとに主要な問い、制約・スコープ、研究計画を提案する。計画に承認を得たら、**Researcher を主要な問いごとに並列**で起動して情報を収集し、Writer がレポートを作成、**Reviewer をレビュー観点ごとに並列**で起動してレビューするというサイクルを回す。

調査成果物は `tmp/research/yyyymmdd-[topic]/` ディレクトリにまとめる。レポートはチェックポイントを経て随時更新するが、セッション上に全文を出力することはなく、常にファイルを参照してもらう。

## 🧠 前提知識

### 利用するツール

| ツール | 役割 |
| --- | --- |
| SearXNG (localhost:8080) | ローカルで動作するメタ検索エンジン。JSON API で構造化結果を返す |
| `curl` | SearXNG API の呼び出し、および公開 URL の HTML 取得に使用 |
| `jq` | SearXNG API の JSON レスポンスを整形・抽出する |
| `pandoc` | 取得した HTML を Markdown に変換する |

### SearXNG の起動

SearXNG は Docker Compose で管理する。リポジトリの `docker/` ディレクトリから起動する。

```bash
mise run docker-up
```

停止:

```bash
mise run docker-down
```

前提チェック:

```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"
```

HTTP 200 が返らない場合は、SearXNG が起動していない。ユーザーに起動を促し、Skill を中断する。

`jq` と `pandoc` の確認:

```bash
command -v jq
command -v pandoc
```

未インストールの場合は、環境に応じてインストールを案内する。

macOS の例:

```bash
brew install jq pandoc
```

### 外部通信の扱い

この Skill は SearXNG 経由で Web 検索したり、公開 URL を取得したりするために外部サイトへ GET リクエストを送る。
実行前の短い宣言として、ユーザーへ以下を明示する。
最終結果にも、実際に送信した検索クエリまたは URL を再掲する。

- 送信先: ローカル SearXNG（内部で複数の検索エンジンへリクエスト）、または取得対象の公開 URL
- 送信データ: 検索クエリ、または指定 URL
- 目的: 検索結果取得、またはページ本文取得

ファイルアップロード、外部 POST / PUT、認証情報を含むリクエストは行わない。
社内情報、顧客情報、秘密情報を検索クエリや URL パラメータに含める必要がある場合は、実行せず中断する。

### 出力ディレクトリと命名

調査の成果物は、対象プロジェクトの `tmp/research/yyyymmdd-[topic]/` 配下に保存する。
同日・同テーマで既にディレクトリが存在する場合は、連番を付与する。

例:

- `tmp/research/20260115-rust-async/`
- `tmp/research/20260115-rust-async-2/`

ディレクトリ内のファイル:

| ファイル | 作成者 | 用途 |
| --- | --- | --- |
| `plan.md` | Planner | 研究計画書 |
| `evidence-q{N}.md` | Researcher | 各主要な問いに対する調査エビデンス |
| `evidence-q{N}-{M}.md` | Researcher | 追加調査ラウンドのエビデンス（`M` はラウンド番号） |
| `report.md` | Writer | 最終レポート |
| `review-{aspect}.md` | Reviewer | 各レビュー観点のレビュー結果 |
| `review-{aspect}-{M}.md` | Reviewer | 改善ループ時のレビュー結果（`M` はループ番号） |

レビュー観点の識別子:

| 番号 | 観点 | 識別子 |
| --- | --- | --- |
| 1 | 主要な問いへの回答度 | `coverage` |
| 2 | 情報源の網羅性と信頼性 | `sources` |
| 3 | 事実の正確性と誇張の有無 | `accuracy` |
| 4 | 論理構成と読みやすさ | `structure` |
| 5 | 引用形式の正確さ | `citations` |

## 🏃 ステップ

### 1. 前提チェック

SearXNG が `localhost:8080` で応答するか確認する。
応答しない場合は、`mise run docker-up` で起動するようユーザーに案内する。
`jq` と `pandoc` が利用可能かも確認し、不足している場合はインストール案内を出す。

### 2. 事前ヒアリング

調査を開始する前に、ユーザーから以下の情報を引き出すための対話的ヒアリングを行う。
質問は一度に 1 つずつ行い、ユーザーの回答に基づいて次の質問を調整する。

#### ヒアリング項目

1. **調査の背景・目的**: なぜこの調査が必要か、何に使いたいか
2. **既に知っている前提知識**: 既知の情報、過去に調査した内容

**主要な問いはただ聞かない**。Planner が軽い事前調査をもとに提案するため、ここでは背景・目的・前提知識を引き出すことに集中する。

**制約・スコープのヒアリングは行わない**。制約・スコープは Planner が計画書で提案し、ユーザーは計画書全体として承認する。

#### ヒアリングの進め方

- ユーザーが明示的に「十分」と宣言するまで質問を継続する
- 質問回数に固定上限を設けない
- 認識が不十分なまま調査を開始しない

### 3. ディレクトリ作成

ヒアリング完了後、`tmp/research/yyyymmdd-[topic]/` ディレクトリを作成する。

```bash
mkdir -p "tmp/research/20260115-rust-async"
```

### 4. 計画立案（Planner）

Planner SubAgent を呼び出し、軽い事前調査を経て `plan.md` を作成させる。

#### 計画書に含める内容

- 背景・目的
- 前提知識
- **Planner が提案する制約・スコープ**
- Planner が提案する主要な問い（3〜7 個を目安とし、最大 5 個まで推奨）
- 検索戦略（キーワードや重視する情報源の種別）
- 期待されるレポート構成
- 調査終了の判定基準

主要な問いは、並列化した Researcher SubAgent の単位になる。各問いは独立して調査でき、かつ全体として調査目的を網羅する粒度にする。

#### ユーザー承認

オーケストレーターは `plan.md` の要約（背景・目的、主要な問い、制約・スコープ、検索戦略）をユーザーに提示し、承認を得る。
承認されない場合は、フィードバックを Planner に渡して改訂を依頼する。改訂は最大 3 回までとし、それでも合意に至らなければユーザーに「範囲を狭める」「このまま進める」「中断する」を選択してもらう。

### 5. 調査（Researcher）

Planner の計画書に基づき、**主要な問いごとに Researcher SubAgent を並列で呼び出す**。同時起動数の上限は 5 つとし、問いが 5 つを超える場合はバッチ化する。

#### 並列起動の例

主要な問いが 3 つの場合:

- `mt-deep-research-researcher` × 3（問い 1、問い 2、問い 3）を同時に起動
- 各 SubAgent は担当する問いと `plan.md` を入力として受け取る
- 各 SubAgent は `evidence-q1.md`, `evidence-q2.md`, `evidence-q3.md` を作成する

#### 調査ループ

各 Researcher SubAgent は以下のループを自律的に実行する（最大 3 ループ）。

1. **検索クエリの生成**: 担当する問いと計画書に基づき、最適な検索クエリを生成する
2. **検索実行**: SearXNG JSON API で検索し、結果を取得する
3. **結果の分析**: 検索結果から、最も関連性の高い URL を選定する
4. **本文取得**: 選定した URL の本文を `curl` と `pandoc` で取得する
5. **情報抽出**: 本文から主要な情報を抽出し、作業領域に蓄積する
6. **次のアクションの決定**: 担当する問いに対する調査が十分か、追加の検索が必要かを判断する

#### 検索実行

SearXNG JSON API を使用する:

```bash
curl -s "http://localhost:8080/search?q=%E6%A4%9C%E7%B4%A2%E3%82%AF%E3%82%A8%E3%83%AA&format=json" \
  | jq -r '.results[:8][] | "- [" + .title + "](" + .url + ") - " + (.content // "")'
```

検索クエリは URL エンコードする。`jq` で `results` 配列から上位 8 件を抽出し、タイトル・URL・概要を整形する。
Shell ツールで実行する場合は、必要に応じて `timeout 20s` などを併用し、検索コマンドを長時間待ち続けない。
Shell ツールで実行する場合は SearXNG 経由で外部の検索エンジンへ通信が発生するため、必要に応じて `required_permissions: ["full_network"]` を付与する。

SearXNG が HTTP エラーを返す、JSON が空、または関連候補が出ない場合は失敗扱いにする。
その場合はクエリの短縮、公式ドメイン指定の追加、`categories=general` の明示など、1 回ずつ理由を変えて再試行する。
再試行しても不足する場合は、検索結果として断定せず「取得不足」として次の安全な確認方法を示す。

#### URL 本文取得

```bash
curl -L --fail --silent --show-error --max-time 20 \
  --user-agent "Mozilla/5.0" \
  "https://example.com/article" \
  | pandoc -f html -t gfm
```

#### エビデンスファイルの作成

Researcher は担当する問いに対して `evidence-q{N}.md` を作成する。ファイルには以下を含める。

- 調査の対象とした主要な問い
- ソース一覧（番号・タイトル・URL・種類・アクセス日）
- 番号引用付きの抽出事実
- カバレッジ自己評価（十分に回答できたか、追加調査が必要か）
- 目的から外れそうな問い（あれば）

追加調査が必要になった場合、同じ問いに対して `evidence-q{N}-2.md`, `evidence-q{N}-3.md` のようにサフィックスで付番したファイルを新規作成する。既存のエビデンスは上書きしない。

#### 目的から外れそうな問いの扱い

調査中に新たな問いが生まれた場合、その問いが「当初の目的に直接役立つか」を 1 文で説明し、エビデンスファイルの「目的から外れそうな問い」セクションに記録する。

- 明らかに当初の目的や制約に沿っている問いは、そのまま調査を継続する
- 目的から外れそうだが価値がありそうな問いは、チェックポイントで一括して調査可否を確認する
- 明らかに外れている問いは調査せず、チェックポイントで除外したことを報告する

### 6. レポート作成・レビュー改善ループ

すべての Researcher SubAgent が完了し、エビデンスファイルが揃ったら、Writer → Reviewer のループを実行する。

#### レポート作成（Writer）

Writer SubAgent は `plan.md` と `evidence-*.md` をもとに `report.md` を作成または更新する。

```markdown
# [調査テーマ]

## 前提とスコープ

- 背景・目的: [2〜3 文]
- 前提知識: [2〜3 文]
- 制約・スコープ: [2〜3 文]

## 作成日

YYYY-MM-DD

## 要約

[調査結果の要約]

## 詳細な調査結果

[事実の直後に [1] のような番号引用を付けて記述]

## 情報源の一覧

| 番号 | タイトル | URL | 種類 | アクセス日 |
| --- | --- | --- | --- | --- |
| 1 | [タイトル] | [URL] | [公式リファレンス / チュートリアル / ブログ / フォーラム / ニュース / 論文 / GitHub / その他] | YYYY-MM-DD |
```

#### レビュー（Reviewer）

Writer が `report.md` を作成または更新するたびに、**レビュー観点ごとに Reviewer SubAgent を並列で起動する**。同時起動数の上限は 5 つとする（観点は 5 つなので、通常は 5 つ同時に起動する）。

レビュー観点:

1. 主要な問いへの回答度 (`coverage`)
2. 情報源の網羅性と信頼性 (`sources`)
3. 事実の正確性と誇張の有無 (`accuracy`)
4. 論理構成と読みやすさ (`structure`)
5. 引用形式の正確さ (`citations`)

各 Reviewer SubAgent は `report.md` を担当観点からレビューし、`review-{aspect}.md` に構造化されたレビュー結果を出力する。

レビュー結果のカテゴリ:

- `must_fix`: Writer が必ず修正すべき項目
- `research_needed`: Researcher が追加調査すべき項目
- `suggestions`: 任意で対応すべき改善案

各 Reviewer は担当観点のみを評価し、他の観点の判断は行わない。

#### 改善ループ

オーケストレーターはすべての観点ファイルを読み込み、`must_fix` / `research_needed` / `suggestions` を種別ごとに集約する。

- `must_fix` がある場合は、集約した指摘を 1 つの prompt として Writer に修正を依頼する
- `research_needed` がある場合は、問いごとに指摘をまとめ、対応する Researcher SubAgent に追加調査を依頼する
  - 問い 1 に関する `research_needed` は 1 つの Researcher にまとめて渡す
  - 複数の問いに関する場合は、問いごとに並列で Researcher を起動する
- 1 回の `report.md` 更新あたり、Writer → Reviewer を最大 3 回まで繰り返す
- 3 回を超えても `must_fix` や `research_needed` が残る場合は、ユーザーに理由をサマリーして方針を仰ぐ

追加調査後の再レビューでは、すべての観点を再レビューする。ただし、前回のレビュー結果（`review-{aspect}.md`）を参照して、変更点や前回の指摘への対応に絞って評価させる。再レビューのファイル名は `review-{aspect}-2.md`, `review-{aspect}-3.md` のようにサフィックスで付番する。

#### ユーザーへのチェックポイント

内部ループが収束したら、オーケストレーターはユーザーに以下を 3〜5 行で提示する。

- 新しく追加した主な事実
- 確認してほしいポイント
- 目的から外れそうで保留している問い（あれば）

全文をセッションに出力しない。ユーザーにはファイルを開いて確認してもらう。

ユーザーに対し、以下のような具体的な観点でフィードバックを求める。

- 追加した事実に誤りや誇張はないか
- この方向性でさらに深掘りすべきか
- 見落としている視点や補足してほしい情報はないか
- 保留中の目的外問いについて、調査するかどうか

ユーザーからのフィードバックがない、あるいは「特にない」などの曖昧な回答があった場合は、次に調査しようとしているステップを 1 文で提示し、「この方向で進めてよいか」を確認する。

### 7. 最終レポートの確定

以下の条件を満たした場合は、最終レポートの確定へ進む。

- 計画書で出た主要な問いに対し、十分な証拠付きで回答できている
- 目的から外れそうな問いはユーザー確認済みで、調査対象として確定しているか除外されている

主要な問いの 1 つでも回答できないものがあり、かつ追加調査の見込みがない場合は、ユーザーに「追加調査を続けるか」「この時点で終了するか」を確認する。

調査終了後、`report.md` を最終更新する。
レポート内に以下のような記載は含めない。

- 未解決の問いに関するセクション
- 次のアクションに関するセクション
- ループごとの検索ログや中間まとめ
- SearXNG の信頼性に関する注意書き（これは調査開始時の説明と Skill 注意事項に任せる）

最終的なレポートの内容のみをファイルに残す。

完了をユーザーに伝える際は、以下のように簡潔にする。

```
調査が完了しました。X 件の情報源を確認しました。レポートは tmp/research/yyyymmdd-[topic]/report.md に保存しました。
```

レポート全文をセッション上に出力しない。

## 🤖 利用 SubAgent

| 役割 | SubAgent type | readonly | 定義ファイル |
| ---- | ---- | ---- | ---- |
| Planner | `mt-deep-research-planner` | false | `_cursor_user/agents/mt-deep-research-planner.md` |
| Researcher | `mt-deep-research-researcher` | false | `_cursor_user/agents/mt-deep-research-researcher.md` |
| Writer | `mt-deep-research-writer` | false | `_cursor_user/agents/mt-deep-research-writer.md` |
| Reviewer | `mt-deep-research-reviewer` | true | `_cursor_user/agents/mt-deep-research-reviewer.md` |

SubAgent への委譲方法、prompt 構造、ループ制御、エラーハンドリング、並列化の詳細は `subagent-protocol.md` を参照する。

## ✅ 完了条件

- 事前ヒアリングが完了し、調査の背景・目的・前提知識が明確になっている
- Planner による研究計画書 `plan.md` が作成され、ユーザー承認を得ている
- Planner が主要な問い（3〜7 個、目安）と制約・スコープを提案している
- Researcher が主要な問いごとに並列起動され、各問いに対するエビデンスファイルが作成されている
- Writer → Reviewer の改善ループが実行され、主要な問いに回答できている
- Reviewer が観点ごとに並列起動され、レビュー結果ファイルが作成されている
- 目的から外れそうな問いはユーザー確認が行われ、対応が確定している
- チェックポイントで `report.md` が作成・更新されている
- 最終レポートが `tmp/research/yyyymmdd-[topic]/report.md` に保存されている
- セッション上にレポート全文を出力していない
- 外部通信前に、送信先・送信データ・目的が明示されている
- SearXNG が起動していることを確認している

## 📦 アウトプット

- `tmp/research/yyyymmdd-[topic]/plan.md`（研究計画書）
- `tmp/research/yyyymmdd-[topic]/evidence-q{N}.md`（各主要な問いのエビデンス）
- `tmp/research/yyyymmdd-[topic]/evidence-q{N}-{M}.md`（追加調査ラウンドのエビデンス）
- `tmp/research/yyyymmdd-[topic]/report.md`（最終レポート）
- `tmp/research/yyyymmdd-[topic]/review-{aspect}.md`（各レビュー観点の結果）
- `tmp/research/yyyymmdd-[topic]/review-{aspect}-{M}.md`（改善ループ時のレビュー結果）
- チェックポイント時の簡潔なサマリーとファイルパス
- 調査完了時の簡潔な完了メッセージ

## ⚠️ 注意事項

- 検索クエリや URL に社内情報、顧客情報、認証情報、秘密情報を含めない
- ファイルアップロード、外部 POST / PUT、認証付きアクセスは行わない
- URL は必ずクォートする
- `curl` は `--max-time` を付け、長時間ハングさせない
- Web サイトの利用規約や robots 的な制約に反する大量取得はしない
- SearXNG の結果は複数の検索エンジン由来であり、正確性を保証しない。重要情報は一次情報を確認する
- ループを無限に継続しない。Writer-Reviewer ループは 1 回のレポート更新あたり最大 3 回までとする
- レポート全文をセッション上に出力しない。常にファイルを参照してもらう
- Researcher SubAgent は同時に最大 5 つまで、Reviewer SubAgent も同時に最大 5 つまで起動する
