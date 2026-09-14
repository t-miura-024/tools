---
status: accepted
---

# difit レビューの表示はローカルサーバーの URL 提示のみ

difit レビューの表示は、`mt difit start` が提示するローカルサーバーの URL（`http://localhost:<port>`）を人間に示すのみとする。herdr のタブ作成や terminal-browser の起動・タブライフサイクル管理（再作成・冪等クローズ）は行わず、ワークフロー定義・CLI はこれらの外部ツールに依存しない。レビュー状態は difit サーバ側にあり、表示は人間が URL を開く手段（既存タブ・ブラウザ等）に委ねる。

## Considered Options

- herdr 新規タブ + terminal-browser で自動表示する: ワークフロー定義が herdr / terminal-browser の契約と可用性に依存し、タブ再作成・冪等クローズ・消失復旧の複雑さに見合わない。
- split pane で表示する: 会話ペインと画面領域を奪い合い、レビュー中は会話が狭くなる。
- タブのフォーカスを移す: レビュー開始が人間の作業コンテキストを中断させる。

## Consequences

- ワークフローの表示層は URL の提示のみとなり、herdr / terminal-browser の契約変更に追従する必要がなくなる。
- レビュー開始時に人間は提示された URL を自分で開く（表示の自動化は行わない）。
- difit サーバ・コメント状態の契約（E2E で固定）は表示手段に依存しない。
