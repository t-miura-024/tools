# HTML 報告形式

OS 一時ディレクトリに置く自己完結 HTML。Tailwind CDN と Mermaid CDN を使う。

## 必須要素

- ヘッダー: リポジトリ名、日付、凡例
- 候補カード:
  - Title
  - 推奨度バッジ: Strong / Worth exploring / Speculative
  - Files
  - Before / After 図
  - Problem（1 文）
  - Solution（1 文）
  - Wins（短い箇条書き）
  - ADR 衝突があれば警告
- Top recommendation

## 語彙

- 使う: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality
- 使わない: component, service, API（interface の意味で）, boundary（seam の意味で）

## 配置

```text
$TMPDIR/architecture-review-<timestamp>.html
```

リポジトリ内には書かない。
