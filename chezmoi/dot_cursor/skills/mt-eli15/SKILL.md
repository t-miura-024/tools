---
name: mt-eli15
description: あるトピックを15歳の少年にも分かるように説明する。eli15と言われたり、仕組みの図解を求められた時に使用する。
---

# mt-eli15

このトピックについて何も知らない15歳の少年でも分かるように説明してください。
大きな絵と日常会話レベルの日本語、初歩的な専門用語を使ったHTML形式の成果物で説明してください。
Catppucin Mocha テーマによるdaisyUIを利用して、多種多様なコンポーネントや絵文字、アイコンを駆使して表現力豊かに仕上げてください。
以下をhead内に記述してCDNから関連パッケージを取得してください。
```html
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<link href="https://cdn.jsdelivr.net/npm/@catppuccin/daisyui@2/mocha.css" rel="stylesheet" type="text/css" />
```
メタファーはノイズとなるので用いないでください。
専門用語やドメイン特有の用語を使う必要がある場合は、その用語に関する説明も添えてください。
成果物は `/tmp/mt-eli15/` 配下に `YYYYMMDDHHMMSS_日本語名.html` のフォーマットのファイル名にて格納し、生成したら `open <file path>` を実行してhtmlファイルを開いてください。
