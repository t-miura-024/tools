---
name: mt-search-web
description: ローカル SearXNG、curl、pandoc、jq を使って軽量な Web 検索・URL本文取得・Markdown整形を行う。Web 検索、記事探索、公開URLの内容確認、API キー不要の情報収集が必要な時に使用する。
---

# mt-search-web

ローカル SearXNG インスタンス、`curl`、`pandoc`、`jq` を使って、API キー不要の軽量な Web 検索と公開 URL の本文を取得する。
SearXNG は複数の検索エンジンを束ねるメタ検索エンジンであり、`localhost:8080` で動作する。

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

## 🏃 ステップ

### 1. 前提チェック

SearXNG が `localhost:8080` で応答するか確認する。
応答しない場合は、`mise run docker-up` で起動するようユーザーに案内する。
`jq` と `pandoc` が利用可能かも確認し、不足している場合はインストール案内を出す。

### 2. 目的の判定

ユーザーの要求から、次のどれに該当するか判断する。

| ニーズ | 実行方針 |
| --- | --- |
| トピックに関するページを探す | SearXNG JSON API で検索する |
| 検索結果から候補 URL を比較する | SearXNG JSON API と `jq` でタイトル・URL・概要を整形する |
| URL が分かっていて本文を読みたい | `curl` で取得し、必要なら `pandoc` で Markdown 化する |
| 検索してから本文も確認したい | まず SearXNG で検索、候補選定後に対象 URL だけ `curl` / `pandoc` |

ユーザーが候補 URL の提示だけを求めている場合は、本文取得まで広げない。
本文要約や真偽確認を求められた場合だけ、最有力の公開 URL に絞って取得する。
複数ソースの深い調査が必要でも、最初は小さく検索し、関連性の高い候補だけを取得する。
広範囲なクロールや大量取得は行わない。

### 3. 検索実行

検索クエリを確認し、外部通信の内容を明示してから SearXNG API を実行する。
Shell ツールで実行する場合はローカルホストへの通信だが、SearXNG が外部の検索エンジンへリクエストを送るため、必要に応じて `required_permissions: ["full_network"]` を付与する。

構造化出力（JSON API）を使用する:

```bash
curl -s "http://localhost:8080/search?q=%E6%A4%9C%E7%B4%A2%E3%82%AF%E3%82%A8%E3%83%AA&format=json" \
  | jq -r '.results[:8][] | "- [" + .title + "](" + .url + ") - " + (.content // "")'
```

検索クエリは URL エンコードする。`jq` で `results` 配列から上位 8 件を抽出し、タイトル・URL・概要を整形する。

SearXNG が HTTP エラーを返す、JSON が空、または関連候補が出ない場合は失敗扱いにする。
その場合はクエリの短縮、公式ドメイン指定の追加、`categories=general` の明示など、1 回ずつ理由を変えて再試行する。
再試行しても不足する場合は、検索結果として断定せず「取得不足」として次の安全な確認方法を示す。

#### 検索パラメータ

| パラメータ | 説明 |
| --- | --- |
| `q` | 検索クエリ（URL エンコード必須） |
| `format` | `json` を指定（必須） |
| `categories` | `general`, `images`, `news`, `science`, `it` などを指定可能 |
| `engines` | 特定のエンジンに絞る場合: `google,bing,duckduckgo` |
| `language` | `ja-JP`, `en-US` などを指定可能 |

### 4. URL 本文取得

ユーザーの目的に合う URL が見つかった場合だけ、対象 URL をクォートして取得する。
URL に `?` や `&` が含まれることがあるため、必ず引用符で囲む。

```bash
curl -L --fail --silent --show-error --max-time 20 \
  --user-agent "Mozilla/5.0" \
  "https://example.com/article"
```

HTML を Markdown として読みたい場合:

```bash
curl -L --fail --silent --show-error --max-time 20 \
  --user-agent "Mozilla/5.0" \
  "https://example.com/article" \
  | pandoc -f html -t gfm
```

取得結果が大きすぎる場合は、必要箇所だけに絞るか、ユーザーに対象 URL の再選定を促す。

### 5. 結果の提示

検索結果は、関連度の高い候補を短く整理して提示する。
本文を取得した場合は、ユーザーの要求に応じて要約、重要箇所、引用元 URL を示す。
公式情報や一次情報を求められた場合は、公式 docs、公式 blog / changelog、公式 repository、package registry、第三者記事を区別して提示する。
package registry は `npmjs.com` などの一次 registry と、mirror / aggregator 系の第三者ページを分ける。
分類に該当する候補がない場合は、省略せず「今回の検索結果では該当なし」と示す。
検索結果の概要は、検索結果由来の content を 1 文程度に圧縮する。

提示時は次を守る。

- URL とタイトルを明示する
- 推測と取得事実を混同しない
- 取得できなかったページは、HTTP エラー、タイムアウト、ブロックなど分かる範囲で原因を説明する
- 結果が不十分な場合は、クエリ変更、別候補 URL、手動確認のいずれかを提案する

## ✅ 完了条件

- ユーザーの検索・URL 確認要求に対して、関連する検索結果または取得結果が提示されている
- 外部通信前に、送信先・送信データ・目的が明示されている
- SearXNG が起動していることを確認している
- エラー発生時は原因と次の安全な対応が案内されている

## ⚠️ 注意事項

- 検索クエリや URL に社内情報、顧客情報、認証情報、秘密情報を含めない
- ファイルアップロード、外部 POST / PUT、認証付きアクセスは行わない
- URL は必ずクォートする
- `curl` は `--max-time` を付け、長時間ハングさせない
- Web サイトの利用規約や robots 的な制約に反する大量取得はしない
- SearXNG の結果は複数の検索エンジン由来であり、正確性を保証しない。重要情報は一次情報を確認する
