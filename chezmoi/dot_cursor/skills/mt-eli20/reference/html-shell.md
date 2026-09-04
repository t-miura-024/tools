# HTML雛形（html-shell）

ピン留め版と雛形を定義する。版の真実源はこのファイルのみとする。手順4で読む。

## ピン留め表

| 用途 | URL |
| --- | --- |
| Tailwind | `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3` |
| daisyUI | `https://cdn.jsdelivr.net/npm/daisyui@5.7.27` |
| daisyUI追加テーマ | `https://cdn.jsdelivr.net/npm/daisyui@5.7.27/themes.css` |
| Mermaid（ESM） | `https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs` |
| Cytoscape | `https://cdn.jsdelivr.net/npm/cytoscape@3.34.2/dist/cytoscape.min.js` |

フォールバックは `cdn.jsdelivr.net` → `unpkg.com`（同版・パス置換のみ）の順に `onerror` で切り替える。版はピン留め表の値に固定する。daisyUI v5 ⇔ Tailwind v4の組み合わせを保つ。

## 雛形

```html
<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{topic}の網羅図解</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.7.27">
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3"></script>
<style>
  body { line-height: 1.8; word-break: auto-phrase; }
</style>
</head>
<body class="mx-auto max-w-3xl p-6">
<main>
  <h1>{topic}の網羅図解</h1>
  <!-- 下は一例。見出しの数・順序・装飾は3層（概要→構造→詳細）に沿ってtopic向けに決める -->
  <section><h2>概要</h2></section>
  <section><h2>構造</h2></section>
  <section><h2>詳細＋具体例</h2></section>
  <section><h2>再統合</h2></section>
</main>
<noscript><p>図の描画にはJavaScriptを使います。本文はこのまま読めます。</p></noscript>
<!-- Mermaidを使う場合のみ追加（版は上のピン留め表と同一にする） -->
</body>
</html>
```

縮退表示の条件: CSS・JS遮断でも `main` の本文が読めること。図は要点1文が残ること。固定するのはピン留めCDN・`lang=ja`・縮退可読の3点のみとする。
