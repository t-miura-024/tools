# CONTEXT.md 形式

## 構造

```md
# {Context Name}

{この文脈が何か、なぜ存在するかを 1〜2 文で書く。}

## Language

**Order**:
注文の単位。顧客が一度に依頼するまとまり。
_Avoid_: Purchase, transaction

**Invoice**:
配送後に顧客へ送る支払い請求。
_Avoid_: Bill, payment request
```

## 規則

- 同じ概念に複数の語があるときは 1 つを選び、他は `_Avoid_` に置く
- 定義は 1〜2 文まで。実装詳細は書かない
- このプロジェクト固有の用語だけを載せる
- 自然なまとまりがあれば小見出しで分ける

## 配置

- 単一文脈: リポジトリ直下の `CONTEXT.md`
- 複数文脈: 直下の `CONTEXT-MAP.md` が各 `CONTEXT.md` を指す
- ファイルは最初の用語が確定したときに遅延作成する
