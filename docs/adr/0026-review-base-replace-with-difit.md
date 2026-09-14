---
status: accepted
---

# レビュー基盤を hunk から difit へ再置換

2026-08-13 の ADR-0013 で difit から hunk（TUI）へ移行したが、difit の Web UI は情報密度と柔軟性で hunk に勝り、コメントの CLI / HTTP 操作（注入・回収・検証）によるエージェント連携を difit サーバ越しに実現できる。レビュー基盤を difit へ戻し、`mt hunk` を `mt difit`（start / check / done / status / threads --json / resolve）に置き換える。レビュー表示は `mt difit start` が提示するローカルサーバーの URL のみとし、herdr / terminal-browser には依存しない（ADR-0027）。`start` は再入時に同一 difit 引数・選択キーの実行中サーバを再利用して選択固定のコメント I/O でコメントを追記し、ポートを維持する。コメントは起動時 argv では渡さず、spawn 後に選択キーを確定してから選択クエリ付きの HTTP POST（`/api/comment-imports`）で注入する。stale state や difit 引数の変更時のみ、保存済みの未 resolve コメントを再注入して新サーバを起動する。コメントは thread / reply / resolve モデルで管理し、未 resolve スレッドをゲートでブロックする。エージェントは修正済みの AI 指摘を `mt difit resolve <threadId>`（state 読み取り → 記録 pid の LISTEN 照合 → 選択固定セッションへの resolve を 1 コマンド化）で解決し、人間コメントは人間が解決する。want はノンブロッキングを維持し、人間が reply した場合のみ修正対象とする。`[context]` は AI フローからは注入せず、ノンブロッキング分類としてのみ認識する（contextNotes は廃止のままとする）。hunk 移行後に追加された検証ロジック（effort / diff-only / verdict / Step import 等）は維持し、提示・回収・ゲート層のみを差し替える。ADR-0013 と ADR-0016 を supersede する。

## 決定の補足

### `[context]` taxonomy の扱い

計画草案は「`[context]` taxonomy と contextNotes は廃止のまま」としていたが、実装は「AI フローからは注入しないが、ノンブロッキング分類としてのみ認識する」を採用した。ADR-0005 が定義した「`[context]` は解説であり指摘ではない」という分類を、difit のゲート語義として引き継ぐものである（再採用範囲は「旧 difit ADR の再採用状況」参照）。

- 認識のみ残す理由: 旧 difit 時代のセッションや stdin 直 import には author なしの `[context]` 解説スレッドが残り得る。これをブロッキング扱いすると、対応不要の解説に対して人間の resolve を強要する。認識は本文 1 行目の先頭プレフィックスのみで行い、詳細本文中の文字列は判定に使わない。生成側（mt-review-diff）は `[context]` を生成しないため、新規セッションではこの例外は発生しない。
- ゲート例外の実効範囲: 非ブロッキングになるのは author が `User` でない `[context]` スレッドのみ。人間が投稿したコメント（author: `User`）は本文の内容にかかわらずブロックし、`[context]` と書いてゲートを通過させることはできない。
- 人間 reply の判定: 人間由来とみなすのは author が `User` のメッセージのみで、author を持たない reply を人間とみなすフォールバックは持たない。非ブロッキングの親（want / AI の `[context]`）でも、人間（`User`）の reply が 1 件でも付いたスレッドはブロッキングに昇格する（人間の指示を無視しない）。
- 計画の完了条件 4（未 resolve スレッドがブロック）の解釈: この要求は、want（人間 reply なし）と同じく、AI の `[context]` をノンブロッキングとする例外を含む。`[context]` スレッドは resolve しなくても通過時にセッションが片付く。

### position 合成（ADR-0011）の再採用範囲

difit の comment import スキーマが position を必須とするため、`mt difit start` の stdin 直 import（stdin コメント、および stale 復旧・difit 引数変更時の保存済みコメント再注入）に限り、position なしエントリを `{"side":"new","line":1}` に合成する（ADR-0011 の再採用）。mt-review-diff の findings 経由は position 必須（ADR-0022 の diff-only 契約）であり、position なしは convert 時に機械的に除外され、合成は発生しない。

### コメント注入（argv 廃止と HTTP チャンク）

`mt difit` は difit CLI の `--comment <json>` argv を使わない。コメント全量は OS の引数長上限（macOS は argv 合計 約 1 MiB、Linux は 1 引数 128 KiB）で E2BIG になり、ワークフロー側が読み取れる 16 MiB と非対称なため、1 MiB 超のコメントを argv では書き戻せない。

- `start` は `spawn` 後に `/api/diff` から選択キーを確定（`probe_selection`）し、選択クエリ付きの HTTP POST（`/api/comment-imports`、`add_comments`）で注入する。リクエストは difit の JSON ボディ上限 100 KiB に対する安全マージン（目標 64 KiB）で分割して順に送る（1 件で超える場合は単独リクエスト。reply は親スレッドの直後に並ぶため、分割しても親子関係は保たれる）。
- 選択キーの確定または注入に失敗した場合、起動直後の子プロセス（mt が spawn した difit）は停止してエラーにする（fail-closed。契約は start.test.rs / client.test.rs で固定する）。実行中サーバの再利用中に追記・再取得が失敗した場合は、そのサーバを新しいセッションで起動し直す（`restart_session`）。

### findings → difit-comments の機械導出

mt-review-diff の normalize_findings は findings.json から `buildDifitComments`（純粋関数）で difit comment import 形式の difit-comments.json を機械導出し、注入前に完全一致を検証する。突合キーは type / filePath / position.side / position.line / body で、欠落・改変・余剰・キー生成不能要素（position なし等）は fail とする。

- reviewer-outputs.json（生 findings）→ findings.json の正規化も機械照合する（`auditFindingsNormalization`）。同じ純粋関数パイプライン（基本検証 → `filterFindingsByDiff` → `mergeFindingsByProximity`）で期待値を再導出し、findings / filteredOut の欠落・余剰、`filteredOut.count` と items の不一致、diff.txt 不在は fail とする。集約段で must / should を無音で落とす経路を塞ぐ（counts が自己整合していても通過しない）。
- コメント本文は `formatReviewComment` が GFM Markdown で生成し、severity / taxonomy / axis を 1 行目ヘッダの `·` 区切りトークン（例: `**🚨 must · 🐛 issue · 🎯 req-1**`。Rust の分類契約）で表す。detail / suggestions は攻撃者由来の差分を引用し得るため、コードスパン外の `[` / `]` をエスケープして画像・リンク記法をリテラル化し、difit UI（react-markdown + remark-gfm）を開いた時点での外部 URL 自動リクエストを防ぐ。
- start_difit_review は注入直後の check で、difit-comments.json の各コメント（thread）が選択固定・read-only の `mt difit threads --json` の threads[] に `{filePath, position.side, position.line, body}` の組の multiset として含まれること（containment）を検証する。サーバ側の余剰（前ラウンドの未 resolve スレッド・人間コメント）は許容し、注入側の欠落（同一 body の片方欠落を含む）・位置 / side の差し替え・キー生成不能は fail とする。あわせて stdout 契約（`port` / `url` / `comments`。`url` は `http://localhost:<port>` と完全一致）と state の port、difit-comments.json の件数を突合する。
- `.difit/difit-review.json` の読み取りは「state / 不在 / 読み取り不能」の三値（`readDifitReviewState`）で扱い、読み取り不能（EACCES / EISDIR / 競合）を「セッション不在」と誤診せず fail にする。同じ三値は done 後の後始末検証にも使う。

findings の指摘が提示から漏れたまま人間レビュー・ゲートへ進む経路を塞ぐ（契約は workflow.test.ts で固定する）。

### 検証対象 diff.txt の提示範囲と完全性（target あり / なし）

mt-review-diff の `collect_context` が生成する diff.txt（normalize_findings / audit と検証者が参照する SoT）の収集範囲は、difit に提示される範囲と一致させる。

- target なし: `git -c core.quotePath=false diff "$(git merge-base HEAD "$BASE")"` = merge-base..ワーキングツリー（committed + staged + unstaged を 1 コマンドで含む）+ untracked（`git ls-files --others --exclude-standard` の各ファイルへ `git diff --no-index /dev/null <f>` を追記。index の intent-to-add に依存しない）。`mt difit start <base>` が提示する working diff の範囲と一致する。`git diff "$BASE...HEAD"` + unstaged のような index（staged）を欠く分割収集は staged 変更・staged 新規ファイルを diff.txt から丸ごと落とすため採用しない（collect_context はこの分割収集を禁止し、`git status --porcelain` の staged エントリを diff.txt と機械突合する）。
- target あり: `git diff <base>...<target>` のみとし、untracked は収集しない。difit は target 提示時に working tree の untracked を表示しないため、混ぜると提示範囲（人間とゲートが見る差分）と検証対象（diff.txt）が乖離する。collect_context の完全性検査も target ありでは untracked / staged の欠落照合を行わず、truncate マーカー検査と numstat 突合のみ行う。
- 収集コマンドは `git -c core.quotePath=false` で実行し、diff.txt の SoT に C-quote（octal escape）を持ち込まない。`"` を含むパスは `core.quotePath=false` でも引用されるため、パス解析（`parseDiffChangedLines` → `parseDiffHeaderPath`）は `"b/<path>"` 形を逆写像し、検証者が返す生の filePath とキーを一致させる。untracked の出現照合（`diffContainsUntrackedFile`）は生パスと C-quote 形の両方を候補にする。
- 完全性検査（truncate マーカー + untracked 欠落）は diff.txt を 1 回だけ行展開したインデックス（`indexDiffText`）を共有して行う（打ち切り・生成失敗を SoT に残さない。契約は mt-review-diff / mt-plan-run の workflow.test.ts で固定する）。

### collect_verdict の単一実行プロトコル

`mt difit check` は通過時にサーバ停止・状態削除を行い、ブロック時はセッションを残して次ラウンドで再利用する（計画のゲート意味論）。この契約を維持したまま daemon 照合の空洞化を防ぐため、verdict の生成とゲート判定を次の単一実行プロトコルに固定する。

- `collect_verdict` の task（SubAgent）は `mt difit check` / `mt difit done` を実行せず、選択固定・read-only の `mt difit threads --json` で未 resolve スレッドを取得して verdict.json を生成する。unpinned な `difit comment get` は使わない（選択クエリを指定できず、ブラウザのリビジョン切替で別セッションを読む無音 pass の経路になる）。`blocking_threads` は `mt difit check` の stdout と同一形状にし、body / replies は原文のまま保持する。
- ゲートの権威判定と突合は `collect_verdict` の check フェーズが行う。verdict の形式・ラウンド上限・findings との整合を検証した後に `mt difit check --dry-run`（非破壊。出力 JSON と exit code は通常の check と同一）を一度だけ実行し、task の verdict（passes / blocking_threads）と daemon 出力を canonicalize して比較する。不一致は fail とし、サーバ・状態を変更せず保持する（daemon 照合なしの通過は認めない。前段で止まる場合は check を実行せず、セッションを消費しない）。
- 一致かつ通過（passes=true）の場合のみ `mt difit done` で後始末する（停止・状態削除。done はゲート結果にかかわらず常に `close_session` を実行して exit 0 でゲート結果 JSON を返す契約で、kill はサーバ同一性を照合できた場合のみ行う）。一致かつブロックなら後始末せず、次ラウンドの `start_difit_review` がセッションを再利用する。done の stdout は done 実行時点のゲート結果であり、後始末の成否ではない。後始末の実効性は、done 前後の state 消失と記録 pid の終了で検証し、state 残留・pid 生存は error（後始末未完。orphan の可能性）に倒す。done.passes=false は「dry-run 突合（passes=true）から done 実行までの間にゲートが変わった（人間の追加コメント・返信、または判定不能）」ことを意味するため、後始末失敗と誤診せず、done 出力を `difit-check.json` に永続化し、blocking_threads を executor の feedback として次ラウンドの修正対象に引き継ぐ fail にする（difit セッションは終了済み）。daemon 出力（`check --dry-run` / `done`）は一致・不一致にかかわらず `difit-check.json` に永続化する。
- `mt difit threads --json` の stdout は未 resolve スレッド全件の本文と replies を含むため、ワークフロー側の読み取りは maxBuffer 16 MiB を明示し、超過を「出力サイズ超過」として fail にする（切り詰められた stdout をパース失敗として扱わない）。
- 分類（taxonomy / want の人間 reply 昇格 / author 判定）の権威は Rust の `mt difit check` / `mt difit threads --json`（実装は `src/difit/gate.rs`）にあり、task プロンプトは機械出力をそのまま verdict 化し、規則の写経・再分類をしない。規則の写像が残る箇所（mt-review-diff のプロンプト、agents 3 面、workflow.test.ts）は規則変更時に同時修正する。写像がドリフトすると突合不一致として fail で検出される（Rust 側の判定を読み替えない）。

### human gate と round limit のエスカレーション

mt-review-diff の `await_human_review` は condition を持たず必ず人間に提示し、ゲート通過の検証は collect_verdict の `mt difit check --dry-run` 突合に一本化する（human_gate の check は現行 tado 0.1.0 では実行されないため、到達不能な check を置かない）。2段階ループの must>0 スキップはループ所有者である mt-plan-run だけが condition を override して行い、findings を機械的に読めない場合は skip しない（fail-closed で人間に提示する）。mt-review-diff 単独では must>0 でも必ず人間ゲートを提示する。

mt-plan-run は collect_verdict の check が pass 以外（セッション不在・dry-run 突合の不一致・done 非通過・schema error）を返した場合、`resetReviewCycle` で execute_work より後を pending に戻し、次ラウンド（execute_work → 再検証 → start_difit_review でのセッション復旧）で復旧させる。round limit（round > 3、または round = 3 かつ未通過）は再実行では解消しないため execute_work へ戻さず、mt-plan-run が新設した human gate `round_limit_gate`（受容して完了 / もう1巡 / 中断）へエスカレーションする。mt-review-diff 単独では round limit は fail で終端し、エスカレーション手段は消費者が用意する（契約は workflow.test.ts で固定する）。

### コメント選択のピン留め

difit はコメントを diff の選択（base / target / baseMode）ごとのセッションに分離して保持する。選択クエリのないコメント API はサーバ可変の `currentCommentSelection` を読み書きするため、人間がブラウザ UI のリビジョンセレクタで別の選択に切り替えると、mt が別セッション（多くは未 resolve 0 件）を読んでゲートを無音で通過し得る。ADR-0008 が一致させたのは起動時の選択に限られ、起動後の切り替えは対象外だった。

- `mt difit start` はサーバ起動直後に `/api/diff` の解決済み選択（`baseCommitish` / `targetCommitish` / `requestedBaseMode`）を取得し、`ReviewState.selection`（`base` / `target` / `baseMode`）として `.difit/difit-review.json` に永続化する。再利用時のコメント追記・ゲート判定・stale 復旧時の再注入はすべてこの選択に固定する。
- difit CLI の `comment get/add` は選択を引数で指定できないため、mt difit のコメント読み書きは difit の HTTP API（`/api/comments-json` / `/api/comment-imports` への `base` / `target` / `baseMode` クエリ）で行う。ADR-0008 の「内部 API は使用しない」は、選択固定のためのコメント I/O に限り見直す（引数変換自体は再採用のまま）。この内部契約は E2E テストで固定する。ワークフロー向けにはこの読み取りを `mt difit threads --json`（選択固定・read-only）として公開し、verdict 生成は unpinned な `difit comment get` を使わない。
- クエリ値（`base` / `target` / `baseMode`）は RFC 3986 の unreserved 以外をパーセントエンコードする。解決済み commitish にブランチ由来の `&` `#` `%` `+` 等が残っても、パラメータ分割や空白解釈で読み書きが別セッションへ向かわない（契約は client.test.rs で固定する）。
- `mt difit check`（通常 / `--dry-run`）と `mt difit threads --json` は、固定した選択と difit サーバが現在返す選択（GET `/api/diff`・read-only）を比較し、`selection_drift: {detection, expected, current}` として出力する。`detection` は `detected`（不一致）/ `none`（一致）/ `unavailable`（probe 失敗＝検知不能）の三値で、probe 失敗を「ドリフトなし」へ倒さない。ワークフロー（start_difit_review / collect_verdict）は `none` 以外を fail-closed に扱い、ドリフト中は difit UI の reply / resolve がゲートと別セッションへ書き込まれるため通過・後始末を認めない（契約は check.test.rs / workflow.test.ts で固定する）。
- `mt difit check` は `selection` 未記録の state を、ゲート対象セッションを確定できない状態として扱い、サーバ・状態を変更せず fail-closed で停止する（無音 pass を認めない）。記録済みでもサーバの現在選択が変わっている場合は、固定した選択で判定を継続しつつ stderr に警告を出す。
- 再起動（stale 復旧・difit 引数変更）では新しいサーバの選択を取得して記録し直し、起動 → 選択確定 → state 書き込み完了の後に旧サーバを停止する。spawn・選択取得・書き込みのいずれかに失敗した場合は旧 state を復旧源として残す（起動済みの新サーバは停止する）。
- 既知の制約: 外部 CLI の `difit comment resolve` は選択を指定できない（difit 5.0.12 は `--port` のみ）。人間がリビジョン切替した状態で resolve / reply すると別セッションへ向かい、resolve は 404 で失敗する。エージェントの resolve は選択固定・同一性検証つきの `mt difit resolve <threadId>` に一本化したため、この制約は人間の UI 操作と外部 CLI 直叩きに限られる。mt の `check` は起動時のセッションに固定して読むため無音 pass には至らないが、UI の選択を起動時のリビジョンに戻してから resolve / reply する必要がある。

### resolve の一本化（`mt difit resolve`）

executor / agents の resolve は、外部 CLI の `difit comment resolve --port` 直叩きをやめ、`mt difit resolve <threadId>` に一本化する。1 コマンドで state を fail-closed で読み（symlink 拒否・`pid <= 0` / `port == 0` 拒否・state 不在）、選択キー必須と記録 pid の記録 port LISTEN 照合（「サーバ同一性の検証」参照）を通してから、選択固定で未 resolve スレッドを取得して親 author を確認し（親が人間 `User` のスレッドは拒否して人間の resolve に委ねる）、選択固定の `DELETE /api/comments/<threadId>` を送る。成功時のみ `{"resolved":true,"threadId":"<id>"}` を stdout へ出して exit 0、失敗（state 不在 / 選択未記録 / 同一性未確認 / 未 resolve に不在 / 人間コメント / HTTP 失敗）は stdout に JSON を出さず非 0 exit する。state 由来の port へ無検証で DELETE を送る経路（clone 先に仕込まれた state・PID 再利用）をここで塞ぐ（契約は resolve.test.rs で固定する）。

### サーバ同一性の検証（kill 前照合）

`.difit/difit-review.json` はリポジトリ内の通常ファイルであり、clone 先に仕込まれた細工や PID 再利用により、記録された pid が無関係プロセスを指し得る。`mt difit start` の再起動（旧サーバの停止）、`mt difit check` の通過時、`mt difit done` の後始末は、記録 pid が記録 port を LISTEN していることを OS 情報（macOS: `lsof -nP -sTCP:LISTEN -t -iTCP:<port>`、Linux: `/proc/<pid>/fd` と `/proc/net/tcp{,6}`）で照合できた場合のみ停止する。照合できない場合は kill せず（fail-closed）、警告を stderr に残して人間の判断に委ねる（difit が孤児として残った場合は手動停止する）。生存判定（stale 復旧の `is_server_live`）も同じ照合を含み、difit の軽量プローブ（GET `/api/diff` のみ）で応答を確認する。未 resolve スレッド全件の取得（`/api/comments-json`）はゲート判定（`check`）・読み取り（`threads`）・再利用時の追記（`start`）の経路だけが行い、生存確認で二重取得しない。照合できない旧 pid は kill せず新サーバでの復旧に進む。

同じ照合は読み取り専用経路にも必須とする。`mt difit check --dry-run` と `mt difit threads --json` は、記録 pid が記録 port を LISTEN していることを確認できない場合、state・サーバを一切変更せず非 0 exit する（stale 復旧も後始末もしない。エラーは `mt difit start` でのセッション復旧を案内する）。照合なしに記録 port へ問い合わせると、記録 port で応答する別プロセス（PID 再利用・clone 先に仕込まれた state）から空セッションを読み、未 resolve を残したまま passes:true を返し得るため。

### kill ポリシー（復旧は回収成功時のみ停止・終了経路は明示破棄）

旧 pid の扱いは LISTEN 照合の成否だけでなく「未回収コメントを保持し得るか」で分ける。

- `ensure_server_running`（`check` / `done` の stale 復旧）は旧 pid を kill しない。LISTEN 照合は取れたが difit として応答しない（probe / fetch 失敗）旧サーバは、未回収コメントの唯一の保持者であり得るため停止せず、`warn_server_unresponsive_orphan` で pid と手動停止コマンド（`kill <pid>`）を stderr に残して新サーバで復旧する。LISTEN 照合自体が取れない（プロセスは生存）旧 pid は、無関係プロセスへの kill を避ける `warn_server_identity_unverified` を出す。いずれも旧プロセスは孤児として残り得るため、警告は人間が判別・停止できる形にする。
- `restart_session`（difit 引数変更・再利用失敗時の再起動）は、旧 pid が記録 port を LISTEN していることを照合でき、かつ旧サーバからコメントを取得できた場合に限り、旧 pid を停止対象（`obsolete_pid`）として記憶する（選択キー記録済みなら取得した未 resolve コメントを引き継いで新サーバへ再注入し、未記録の旧 state では保存済みコメントを使う）。旧 pid の停止は、新サーバの起動・選択確定・新 state の保存がすべて成功した後に行い、それまでは旧 state / 旧サーバを復旧源として残す（spawn・選択取得・保存のいずれかに失敗した場合は、起動済みの新サーバだけを停止する）。回収できなかった旧 pid は停止せず、`ensure_server_running` と同じ警告を残す。
- 終了経路（`close_session`。`check` 通過時と `done`）は、直前にコメントを回収済み（check 通過）か明示的な破棄終了（done）であることを前提に `kill_verified_server` で停止する。kill は LISTEN 照合が取れた場合のみで、取れなければ同一性未確認の警告のみを残す（fail-closed。状態削除は行う）。
- この非対称は意図的である。復旧では未回収コメントを失わないため旧サーバを残し、終了では回収済み・破棄済みのため停止できる。

### state 書き込みの tamper 防御

`.difit/difit-review.json` と `.difit/.gitignore` は clone 先リポジトリ内のファイルであり、symlink を仕込まれた状態で create + truncate の書き込み（`fs::write` 相当）を行うと、リンク先の任意ファイルを破壊され得る。state の書き込みは、一時ファイル名を UUID 入りの予測不能名（`difit-review.json.<uuid>.tmp`）にし、`OpenOptions::create_new(true)`（O_CREAT | O_EXCL）で新規作成して、既存パス（symlink を含む）が 1 つでもあれば失敗させる（リンク先を一切開かない）。書き込み成功後は同一ディレクトリ内の rename で置き換え、失敗時は作成した一時ファイルを片付ける。`.difit/.gitignore` の生成も `symlink_metadata` で symlink（dangling を含む。`exists()` では検出できない）を検出したら拒否し、新規作成は同じ `create_new` 経路で行う。後始末（`delete_review_state`）は固定名ではなく `difit-review.json.*.tmp` の残骸を走査して削除する。これにより clone 先に仕込まれた `.difit/difit-review.json.tmp` symlink による任意ファイル上書きを防ぐ（契約は start.test.rs / shared.test.rs で固定する）。

### state スキーマと shared.rs の型再公開

`.difit/difit-review.json` の永続スキーマは表示用のタブ情報を持たない（表示は URL 提示のみ。ADR-0027）。あわせて `shared.rs` を型の再公開ハブにせず、`client` / `gate` の型は利用側が直接 import する。

## 旧 difit ADR の再採用状況

ADR-0013 で superseded とした旧 difit の決定のうち、本 ADR が再採用する範囲を固定する。各 ADR の status にも同じ関係を記録する。

- ADR-0005（should/want の taxonomy と severity 表記）: 一部再採用。`[context]` は「解説であり指摘ではない」として非ブロッキングにする分類と、指摘の性質を taxonomy で区別する枠組みを引き継ぐ。ただし severity の body 表記は旧形式の `(should)` / `(want)` ではなく、絵文字形式のヘッダ（例: `**⚠️ should · 🙋 question · 🎯 req-1**`）に置き換わり、taxonomy も `[question]` 統一ではなく `🐛 issue`（AI 発見の問題点）/ `🙋 question`（AI が人間に判断を仰ぐ）の 2 分類に拡張された。旧形式の先頭プレフィックス（`[issue]` / `[question]` / `[context]`）は旧セッションの再注入・stdin 直 import のため読み取り互換のみ残す。
- ADR-0007（`mt difit done`）: 再採用。done は standalone 終了用で、ゲート結果にかかわらずサーバ停止・状態削除・exit 0。
- ADR-0008（`mt difit start` の引数変換）: 一部再採用。引数変換（`--clean` / `--merge-base` 等の公式 CLI オプション）と起動時の選択一致は再採用するが、「内部 API は使用しない」は選択固定のためのコメント I/O に限り見直す（「コメント選択のピン留め」参照）。
- ADR-0009（untracked を diff に含める）: 再採用（実装は変更）。difit 公式の `--include-untracked` を全ターゲットの共通フラグとして付与し、untracked の列挙と `git add --intent-to-add` は difit 自身が起動時に行う（mt 側の intent-to-add 再実装は削除）。証拠層（collect_context）は `git diff --no-index` で untracked を diff.txt へ追記する（「検証対象 diff.txt の提示範囲と完全性（target あり / なし）」参照）。ハング前提の撤回と `git commit -a` リスク評価は ADR-0009「再採用範囲（ADR-0026）」を参照。
- ADR-0011（position 合成）: 一部再採用。stdin 直 import 経路のみ（「決定の補足」参照）。

## Considered Options

- hunk を使い続ける: TUI の表現力では指摘の構造化表示と人間の操作（reply / resolve）の柔軟性が不足する。
- CLI を作らずワークフロー側で difit を直接制御する: サーバ管理・stale 復旧・コメント変換を再実装することになり、実績ある difit テスト群を失う。
- 移行前 difit 仕様へ完全回帰する: hunk 時代の改良（want ノンブロッキング等）を失うため、選別移植のハイブリッドを採用する。
- `[context]` を計画どおり完全廃止する: 旧 difit 経路の解説スレッドがブロッキング化し、対応不要の解説に人間の resolve を強要するため、認識のみ残す方式を採用する。

## Consequences

- `mt hunk` と `.hunk` は撤去され、現行の実装（src / manifests / workflows / agents）から参照ゼロを grep で確認できる（superseded ADR の歴史的記述を除く）。
- `mt difit start` の再入はポートを維持するため、ブロック中のラウンド間で同じサーバ・コメントセッションが継続し、人間の resolve 操作が無効化されない。
- resolve / want / 人間 reply の意味論が `mt difit check` に集約され、ワークフローのゲート判定が単純化される。
- difit の内部契約（position 必須など）に依存し、`latest` 追従の破壊は E2E テストで検知する。difit 不在時の E2E は既定で skip されるため、検証を主張する実行は `MT_REQUIRE_DIFIT=1` で skip を失敗に変え、skip 0 件で実行する（手順は `src/README.md` / `README.md`）。
