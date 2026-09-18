# コードベース設計語彙

深い module を設計・評価するときの共有語彙。

## 用語

**Module** — interface と implementation を持つもの。関数・クラス・パッケージ・横断スライスのいずれでもよい。
_Avoid_: unit, component, service

**Interface** — 呼び出し側が正しく使うために知るべきすべて。型だけでなく不変条件、順序制約、エラーモード、設定、性能特性を含む。
_Avoid_: API, signature（型面だけを指す語）

**Implementation** — module の内部。

**Depth** — interface 1 単位あたりに得られる振る舞いの量。少ない interface の裏に多くの振る舞いがあるとき **deep**、interface が implementation と同じくらい複雑なとき **shallow**。

**Seam** — その場を編集せずに振る舞いを差し替えられる場所。interface が置かれる位置。
_Avoid_: boundary

**Adapter** — seam で interface を満たす具体物。

**Leverage** — 深さから呼び出し側が得るもの。1 つの implementation が多数の呼び出しとテストに効く。

**Locality** — 深さから保守者が得るもの。変更・不具合・知識・検証が 1 箇所に集まる。

## 原則

- 深さは interface の性質であり、implementation の行数比ではない
- 削除テスト: 消して複雑さが消えるなら通過層、呼び出し側に広がるなら価値がある
- interface はテスト面でもある。interface を超えて内部を測りたいなら形が悪い
- adapter が 1 つなら仮説的 seam、2 つなら本物の seam

## 差分レビューでの使い方

マクロレビューで次を確認する:

- 変更が浅い module を増やしていないか
- seam をまたぐ漏れがないか
- テストが正しい seam に当たっているか
- 削除テストに耐える module になっているか
