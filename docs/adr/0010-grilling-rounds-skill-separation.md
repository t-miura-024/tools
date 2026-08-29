---
status: superseded
---

# grilling のラウンド制を mt-grill-rounds として分離新設し、grill シリーズのメインに据える

> **Superseded by [ADR 0023](./0023-abolish-mt-grill-me.md)** — `mt-grill-me` の手動専用存置は廃止し、汎用ヒアリングは `mt-grill-rounds` に一本化した。

ADR 0001 では Matt Pocock の `grilling`（ラウンド制・フロンティア）を `mt-grill-me` へ統合したと記録したが、一問一答とラウンド制は質問の提示単位が根本的に異なるため、1 つの SKILL.md に同居できない。ラウンド制＋フロンティア＋SubAgent による非ブロッキング事実調査＋ライブ地図（`grill-map.md`）育成を `mt-grill-rounds` として分離新設し、汎用トリガーをそちらへ移して grill シリーズのメインに据える。`mt-grill-me` は `disable-model-invocation: true` の手動専用として存置し、一問一答で深掘りしたい場面と既存パス参照の受け皿とする。

> **Note:** 上記「`mt-grill-me` は手動専用として存置」の方針は [ADR 0023](./0023-abolish-mt-grill-me.md) で撤回・廃止された。

## Considered Options

- `mt-grill-me` を書き換える置き換え: 一問一答の受け皿が消えるため却下
- 併設＋トリガー同等: 混線するため却下。rounds メインに寄せ、grill-me は手動専用化
- ラウンドあたり質問数の上限: 設けず、フロンティア全体を必ず尋ねる（Pocock 版の原則維持）
