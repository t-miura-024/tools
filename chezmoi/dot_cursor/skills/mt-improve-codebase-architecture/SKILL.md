---
name: mt-improve-codebase-architecture
description: コードベースの浅い module を見つけ、深める候補を HTML 報告し、選んだ候補を徹底ヒアリングする。アーキテクチャ改善、deepening、shallow module と言われた時に使用する。
---

# コードベース設計の改善

浅い module を深い module へ変える候補を見つけ、可視化し、選んだ候補を詰める。

## 🧠 前提知識

- 設計語彙: [../_shared/codebase-design-vocabulary.md](../_shared/codebase-design-vocabulary.md)
- HTML 報告: [HTML-REPORT.md](HTML-REPORT.md)
- 使う語: module / interface / implementation / depth / seam / adapter / leverage / locality
- 使わない語: component / service / API / boundary（この Skill の意味では）

## 🏃 ステップ

### 1. 探索範囲を決める

- ユーザーが module・subsystem・痛みを指定していればそれを使う
- なければ最近の変更が多い箇所を `git log --oneline` から優先する
- `CONTEXT.md` と関連 ADR があれば先に読む

### 2. 摩擦を集める

Explore でコードを歩き、次をメモする:

- 1 概念を理解するのに多数の浅い module を跨ぐ
- interface が implementation と同じくらい複雑
- テスト容易化のために切り出したが、本物の不具合は呼び出し側にある
- seam をまたいで状態や知識が漏れる
- 現 interface 経由ではテストしにくい

削除テストを使う: その module を消したら複雑さが消えるなら通過層、呼び出し側に広がるなら価値がある。

### 3. HTML 報告を出す

- OS 一時ディレクトリに `architecture-review-<timestamp>.html` を書く
- リポジトリ内には置かない
- 各候補に Files / Problem / Solution / Benefits / Before-After / 推奨度を載せる
- 最後に Top recommendation を置く
- 絶対パスをユーザーに伝え、開く

まだ interface 案は出さない。ユーザーに「どれを深掘りするか」を聞く。

### 4. 選ばれた候補を詰める

- `mt-grill-me` または `mt-grill-with-docs` で制約・依存・seam・残すテストを詰める
- 新しい概念名が要るなら `CONTEXT.md` 更新を提案する
- 却下理由が将来の再提案を防ぐなら ADR を提案する

## ✅ 完了条件

- 候補が HTML 報告として提示されている
- ユーザーが深掘り対象を選べる
- 選ばれた候補について決定事項または未解決点が残っている

## 📦 アウトプット

- 一時ディレクトリ上の HTML 報告
- 必要なら用語集・ADR の更新提案

## ⚠️ 注意事項

- 既存 ADR と矛盾する案は、再検討に足る摩擦があるときだけ出し、明示する
- 実装そのものはこの Skill の完了条件に含めない
