# CONTEXT.md 形式

## 構造

```md
# {Context Name}

{この文脈が何か、なぜ存在するかを 1〜2 文で書く。}

## Language

**Order**:
{用語を 1〜2 文で記述する}
_Avoid_: Purchase, transaction

**Invoice**:
配送後に顧客へ送る支払い請求。
_Avoid_: Bill, payment request

**Customer**:
注文を行う個人または組織。
_Avoid_: Client, buyer, account
```

## 規則

- **意見を持つ。** 同じ概念に複数の語があるときは最良の 1 つを選び、他は `_Avoid_` に置く。
- **定義は短く。** 最大 1〜2 文。何をするかではなく、何であるかを定義する。
- **このプロジェクトの文脈に固有の用語だけを載せる。** 一般的なプログラミング概念（タイムアウト、エラー型、ユーティリティパターン）は、プロジェクトで多用していても載せない。用語を追加する前に自問する: これはこの文脈に固有の概念か、それとも一般的なプログラミング概念か？前者だけが属する。
- **自然なまとまりがあれば小見出しで分ける。** すべての用語が 1 つの凝集した領域に属するなら、フラットなリストでよい。

## 単一文脈 vs 複数文脈リポジトリ

**単一文脈（ほとんどのリポジトリ）:** リポジトリ直下に 1 つの `CONTEXT.md`。

**複数文脈:** ルートの `CONTEXT-MAP.md` が各文脈の所在・関係性を列挙する:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — 顧客注文の受付と追跡
- [Billing](./src/billing/CONTEXT.md) — 請求書生成と支払い処理
- [Fulfillment](./src/fulfillment/CONTEXT.md) — 倉庫ピッキングと配送の管理

## Relationships

- **Ordering → Fulfillment**: Ordering は `OrderPlaced` イベントを発行; Fulfillment はそれを消費してピッキングを開始
- **Fulfillment → Billing**: Fulfillment は `ShipmentDispatched` イベントを発行; Billing はそれを消費して請求書を生成
- **Ordering ↔ Billing**: `CustomerId` と `Money` の共有型
```

Skill はどの構造が該当するかを推論する:

- `CONTEXT-MAP.md` が存在すれば、それを読んで文脈を探す
- ルートの `CONTEXT.md` だけが存在すれば、単一文脈
- どちらも存在しなければ、最初の用語が確定した時点でルートの `CONTEXT.md` を遅延作成する

複数文脈が存在する場合、現在のトピックがどの文脈に関係するかを推論する。不明確な場合は質問する。
