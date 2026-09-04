---
name: mt-eli20
description: 知識ゼロの大人向けに難解な概念を単一HTMLで網羅図解する。網羅図解して、mt-eli20と言われた時に使用する。
---

# mt-eli20

知識ゼロの大人向けに、情報を落とさず3層ラダーで精緻化し、単一HTMLに図式化する。

## 入力

`$ARGUMENTS` を3点に分解する: topic / 目的・用途 / 深さ・前提知識。欠けた項目は既定値（目的=理解定着、深さ=入門）で進み、聞き返さない。

## 手順

1. 網羅観点を列挙する。[`reference/content-ladder.md`](reference/content-ladder.md) の観点表を埋め、空欄ゼロを確定してから書く。
2. 3層本文を書く。概要→構造→詳細＋具体例、全体→部分→再統合の順に進む。
3. 図を付ける。既定Mermaid、網・大規模・操作が必要な時のみCytoscape。基準と書式は [`reference/figures.md`](reference/figures.md)。
4. 単一HTMLに組み立てる。雛形・ピン留めCDN・縮退表示は [`reference/html-shell.md`](reference/html-shell.md)。
5. 完了条件を目視で照合し、すべて合致したら出力する。

## 完了条件

- 観点表の空欄ゼロ
- 3層が揃い、詳細層の各主張が具体例または図と対になっている
- 構造層に図が1枚以上あり、図の用語が本文の用語と一致する
- 比喩ゼロ、または対応表＋射程の明記あり
- 単一HTMLで、CDN遮断の縮退表示でも本文が読める
