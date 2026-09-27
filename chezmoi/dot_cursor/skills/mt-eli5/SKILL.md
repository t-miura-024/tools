---
name: mt-eli5
description: あるトピックを5歳児にも分かるように説明する。eli5と言われたり、仕組みの図解を求められた時に使用する。
---

# mt-eli5

このトピックについて何も知らない5歳児でも分かるように説明してください。
大きな絵と少ない言葉を使ったHTML形式の成果物で説明してください。
Catppucin Mocha テーマによるdaisyUIを利用して、多種多様なコンポーネントや絵文字、アイコンを駆使して表現力豊かに仕上げてください。
以下をhead内に記述してCDNから関連パッケージを取得してください。
```html
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<link href="https://cdn.jsdelivr.net/npm/@catppuccin/daisyui@2/mocha.css" rel="stylesheet" type="text/css" />
```
成果物は `/tmp/mt-eli15/` 配下に `YYYYMMDDHHMMSS_日本語名.html` のフォーマットのファイル名にて格納し、生成したら `open <file path>` を実行してhtmlファイルを開いてください。
