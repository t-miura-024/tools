//! `mt difit check` のテスト。
//!
//! 実 difit バイナリを使ったゲート判定・クリーンアップの統合テストを含む。

use super::*;
use crate::difit::{client, gate};
use crate::test_support::{make_temp_git_repo, require_difit, run_mt_with_env};

// ---------------------------------------------------------------------------
// ユニットテスト: output_for_response
// ---------------------------------------------------------------------------

fn make_message(id: &str, author: Option<&str>, body: &str) -> gate::Message {
    gate::Message {
        id: id.to_string(),
        author: author.map(str::to_string),
        body: body.to_string(),
    }
}

fn make_thread(body: &str) -> gate::Thread {
    gate::Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 2}),
        messages: vec![make_message("m1", None, body)],
    }
}

fn make_thread_with_author(author: &str, body: &str) -> gate::Thread {
    gate::Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 2}),
        messages: vec![make_message("m1", Some(author), body)],
    }
}

fn make_thread_with_reply(parent_body: &str, reply_body: &str) -> gate::Thread {
    make_thread_with_authors(None, parent_body, None, reply_body)
}

fn make_thread_with_authors(
    parent_author: Option<&str>,
    parent_body: &str,
    reply_author: Option<&str>,
    reply_body: &str,
) -> gate::Thread {
    gate::Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 2}),
        messages: vec![
            make_message("m1", parent_author, parent_body),
            make_message("m2", reply_author, reply_body),
        ],
    }
}

fn response_for(threads: Vec<gate::Thread>) -> client::CommentGetResponse {
    client::CommentGetResponse {
        version: 1,
        threads,
    }
}

#[test]
fn test_output_for_empty_threads_passes() {
    let out = output_for_response(&response_for(vec![]));
    assert!(out.passes);
    assert!(out.blocking_threads.is_empty());
}

#[test]
fn test_output_for_want_thread_passes() {
    let out = output_for_response(&response_for(vec![make_thread(
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — consider",
    )]));
    assert!(out.passes, "want はノンブロッキング");
    assert!(out.blocking_threads.is_empty());
}

#[test]
fn test_output_for_context_thread_passes() {
    let out = output_for_response(&response_for(vec![make_thread("[context] informational")]));
    assert!(out.passes);
}

#[test]
fn test_output_for_issue_thread_blocks_with_taxonomy() {
    let out = output_for_response(&response_for(vec![make_thread(
        "🚨 must · 🐛 issue · 🎯 req-1 | a.txt:2 — bug",
    )]));
    assert!(!out.passes);
    assert_eq!(out.blocking_threads.len(), 1);
    let blocking = &out.blocking_threads[0];
    assert_eq!(blocking.taxonomy, "issue");
    assert_eq!(blocking.id, "t1");
    assert_eq!(blocking.file, "a.txt");
    assert_eq!(blocking.line, Some(serde_json::json!(2)));
    assert!(blocking.replies.is_empty());
}

#[test]
fn test_output_for_question_thread_blocks_with_taxonomy() {
    let out = output_for_response(&response_for(vec![make_thread(
        "[question] which approach?",
    )]));
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "question");
}

#[test]
fn test_output_for_human_thread_blocks_as_human() {
    let out = output_for_response(&response_for(vec![make_thread("please fix")]));
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "human");
}

#[test]
fn test_output_for_human_comment_quoting_taxonomy_is_human() {
    // 人間（author: "User"）の投稿は本文に taxonomy 絵文字を含んでも Human として扱う
    let out = output_for_response(&response_for(vec![make_thread_with_author(
        "User",
        "🚨 must · 🐛 issue · 🎯 req-1 を引用した人間コメント",
    )]));
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "human");
}

#[test]
fn test_output_for_human_want_comment_still_blocks() {
    // 人間コメントは本文が 💡 want ヘッダ風でもブロックする
    let out = output_for_response(&response_for(vec![make_thread_with_author(
        "User",
        "**💡 want · 🙋 question · ⚡ logic-4** に対する回答",
    )]));
    assert!(
        !out.passes,
        "人間コメントを want と誤認してノンブロッキングにしない"
    );
    assert_eq!(out.blocking_threads[0].taxonomy, "human");
}

#[test]
fn test_output_for_want_with_human_reply_is_promoted() {
    let out = output_for_response(&response_for(vec![make_thread_with_authors(
        None,
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — x",
        Some("User"),
        "please fix this too",
    )]));
    assert!(
        !out.passes,
        "人間 reply のある want はブロッキングに昇格する"
    );
    let blocking = &out.blocking_threads[0];
    assert_eq!(blocking.taxonomy, "question");
    assert_eq!(blocking.replies, vec!["please fix this too".to_string()]);
}

#[test]
fn test_output_for_want_with_authorless_reply_does_not_promote() {
    // author を持たない reply は人間由来とみなさない（author: "User" が唯一の根拠）
    let out = output_for_response(&response_for(vec![make_thread_with_reply(
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — x",
        "[issue] generated reply",
    )]));
    assert!(out.passes);
}

#[test]
fn test_output_for_context_with_human_reply_is_promoted() {
    // 非ブロッキングの [context] でも、人間（author: "User"）の reply は
    // 人間の指示としてブロックする
    let out = output_for_response(&response_for(vec![make_thread_with_authors(
        None,
        "[context] FYI",
        Some("User"),
        "これも直して",
    )]));
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "context");
    assert_eq!(
        out.blocking_threads[0].replies,
        vec!["これも直して".to_string()]
    );
}

#[test]
fn test_output_for_want_with_explicit_ai_reply_does_not_promote() {
    // author: "AI" の reply は人間 reply ではないため want はノンブロッキングのまま
    let out = output_for_response(&response_for(vec![make_thread_with_authors(
        Some("AI"),
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — x",
        Some("AI"),
        "[issue] generated reply",
    )]));
    assert!(out.passes, "AI reply では want を昇格させない");
}

#[test]
fn test_detect_selection_drift_unavailable_on_probe_failure() {
    // probe 失敗（サーバ不応答）を「ドリフトなし（none）」へ倒さず、検知不能として
    // 区別する。ワークフローは unavailable を fail-closed に扱える。
    let expected = client::CommentSelection {
        base: "abc1234".to_string(),
        target: "working".to_string(),
        base_mode: None,
    };
    let drift = detect_selection_drift(9, &expected);
    assert_eq!(drift.detection, DriftDetection::Unavailable);
    assert!(drift.current.is_none(), "現在の選択は取得できない");
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 difit サーバでのゲート判定
// ---------------------------------------------------------------------------

/// サーバを起動し、選択キーつきの状態を保存するヘルパー。
fn setup_server(path: &std::path::Path, comments: &[serde_json::Value]) -> shared::StartedServer {
    let server = shared::start_difit_server(path, &["working".to_string()], comments)
        .expect("difit サーバ起動");
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.to_vec(),
        difit_args: vec!["working".to_string()],
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(path, &state).unwrap();
    server
}

#[test]
fn test_check_gate_blocks_issue_and_resolve_makes_pass() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 1},
            "body": "[issue] problem"
        }),
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[context] info"
        }),
    ];

    let bg = setup_server(&path, &comments);

    // 初期状態: [issue] あり → ブロック
    let resp = client::fetch_comments(bg.port, Some(&bg.selection)).unwrap();
    assert!(!gate::gate_passes(&resp.threads));

    // [issue] スレッドを resolve
    let issue_thread = resp
        .threads
        .iter()
        .find(|t| t.messages[0].body.starts_with("[issue]"))
        .unwrap();
    let resolve_out = crate::git::common::command_with_clean_git_context("difit")
        .args([
            "comment",
            "resolve",
            "--port",
            &bg.port.to_string(),
            &issue_thread.id,
        ])
        .output()
        .expect("resolve");
    assert!(resolve_out.status.success());

    // resolve 後: [context] のみ → 通過（difit の get は resolve 済みを除外する）
    let resp_after = client::fetch_comments(bg.port, Some(&bg.selection)).unwrap();
    assert!(
        gate::gate_passes(&resp_after.threads),
        "resolve 後は通過すべき"
    );

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_cli_blocks_and_keeps_session() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "🚨 must · 🐛 issue · 🎯 req-1 | README.md:2 — bug"
    })];
    let bg = setup_server(&path, &comments);

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(output.status.code(), Some(1), "ブロック時は exit 1");

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "issue");
    assert_eq!(json["blocking_threads"][0]["file"], "README.md");

    assert!(
        shared::is_process_alive(bg.pid),
        "ブロック時はサーバを残して次ラウンドで再利用する"
    );
    let state = shared::read_review_state(&path).expect("状態も残る");
    assert_eq!(state.pid, bg.pid);
    assert_eq!(
        state.comments.len(),
        1,
        "未 resolve コメントが状態に反映される"
    );

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_cli_promotes_want_with_human_reply() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:2 — consider"
    })];
    let bg = setup_server(&path, &comments);

    // want に人間 reply（difit UI は author: "User" を付ける）を追加 → ブロッキングに昇格
    let reply = serde_json::json!({
        "type": "reply",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "これも直して",
        "author": "User"
    });
    client::add_comments(bg.port, Some(&bg.selection), &[reply]).expect("reply 追加");

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "人間 reply 付き want はブロック"
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "question");
    assert_eq!(json["blocking_threads"][0]["replies"][0], "これも直して");

    let state = shared::read_review_state(&path).expect("ブロック時は状態が残る");
    shared::kill_server(state.pid);
}

#[test]
fn test_check_cli_promotes_context_with_human_reply() {
    // 非ブロッキングの [context] に人間（author: "User"）が reply した場合も、
    // 人間の指示としてブロックする（人間 reply は want 専用の昇格条件ではない）。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[context] informational"
    })];
    let bg = setup_server(&path, &comments);

    let reply = serde_json::json!({
        "type": "reply",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "ここも直して",
        "author": "User"
    });
    client::add_comments(bg.port, Some(&bg.selection), &[reply]).expect("reply 追加");

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "人間 reply 付き [context] はブロック: stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "context");
    assert_eq!(json["blocking_threads"][0]["replies"][0], "ここも直して");

    let state = shared::read_review_state(&path).expect("ブロック時は状態が残る");
    shared::kill_server(state.pid);
}

/// ヘルパー: difit サーバの HTTP エンドポイントを GET し、本文を返す。
fn http_get_text(port: u16, path_and_query: &str) -> String {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let url = format!("http://localhost:{}{}", port, path_and_query);
    agent
        .get(&url)
        .call()
        .unwrap_or_else(|e| panic!("GET {} が失敗しました: {e}", url))
        .into_string()
        .expect("応答本文の読み取り")
}

/// HTML 中の `<script ... src="...">` が参照する URL を列挙する。
fn extract_script_srcs(html: &str) -> Vec<String> {
    let mut srcs = Vec::new();
    for fragment in html.split("<script").skip(1) {
        let Some(tag_end) = fragment.find('>') else {
            continue;
        };
        let tag = &fragment[..tag_end];
        for quote in ['"', '\''] {
            let needle = format!("src={quote}");
            if let Some(start) = tag.find(&needle) {
                let rest = &tag[start + needle.len()..];
                if let Some(end) = rest.find(quote) {
                    srcs.push(rest[..end].to_string());
                }
                break;
            }
        }
    }
    srcs
}

/// 稼働中の difit サーバが配信するクライアント（UI）バンドルから、コメント /
/// reply に付ける author 文字列リテラルを抽出する。
///
/// difit UI は人間の投稿を `/api/comment-imports`（mt / AI の注入経路）ではなく
/// `POST /api/comments` へ保存し、messages に `author: \`User\`` を埋め込む。
/// ブラウザが実際に読み込む配信バンドルから値を読むことで、「mt 自身が author を
/// 注入する」テストでは見逃す author ラベルの変更を検知する。抽出できない場合は
/// 配信レイアウトの変更で契約を検証できないことを意味するため panic する
/// （無音で見逃さない）。
fn difit_ui_author_literals(port: u16) -> Vec<String> {
    let html = http_get_text(port, "/");
    let srcs = extract_script_srcs(&html);
    assert!(
        !srcs.is_empty(),
        "difit の index.html に script 参照がありません: {html}"
    );

    let mut authors: Vec<String> = Vec::new();
    for src in srcs {
        let source = http_get_text(port, &src);
        authors.extend(extract_author_literals(&source));
    }
    authors.sort();
    authors.dedup();
    authors
}

/// JS ソース中の `author:` に続く文字列リテラル（`"..."` / `'...'` / 置換なしの
/// バッククォート）の値を列挙する。変数参照（`author:e.author`）や置換つき
/// テンプレートは対象外。
fn extract_author_literals(source: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut rest = source;
    while let Some(index) = rest.find("author:") {
        let after = rest[index + "author:".len()..].trim_start();
        let mut chars = after.chars();
        if let Some(quote @ ('"' | '\'' | '`')) = chars.next() {
            let body = chars.as_str();
            if let Some(end) = body.find(quote) {
                let value = &body[..end];
                if !value.is_empty() && !value.contains('$') {
                    values.push(value.to_string());
                }
            }
        }
        rest = &rest[index + 1..];
    }
    values
}

#[test]
fn test_check_cli_promotes_want_with_human_reply_via_ui_path() {
    // difit UI（クライアント）と同じ経路で人間コメント / reply を作成し、取得時に
    // author が `User` として返ることを実 difit 5.0.12 で固定する。
    //
    // difit UI は人間投稿を `/api/comment-imports`（mt / AI の注入経路）ではなく
    // `POST /api/comments` へ `{threads, baseVersion}` で保存し、messages に
    // `author: \`User\`` を付ける（dist/client の addThread / replyToThread 実装）。
    // この経路とラベルを検証していないと、difit 側が author ラベルを変えた場合に
    // 「人間が reply した want がノンブロッキングのまま通過する」退行が無音になる。
    //
    // 現行契約（author == "User" のみ人間）は維持する: author なし / 未知の author の
    // reply を人間とみなす fail-closed は、AI の reply まで「人間の指示」として
    // ブロック対象に広げてしまうため。author ラベルが変わった場合は、下の抽出照合が
    // 失敗して src/difit/gate.rs の HUMAN_AUTHOR とこのテストの追従を要求する。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:2 — consider"
    })];
    let bg = setup_server(&path, &comments);

    // UI が人間投稿に付ける author ラベルを、稼働中サーバが配信する実バンドルから
    // 抽出し、ゲート契約（gate.rs の HUMAN_AUTHOR）と一致することを固定する。
    assert_eq!(
        difit_ui_author_literals(bg.port),
        vec!["User".to_string()],
        "difit UI の author ラベルが変わりました。src/difit/gate.rs の HUMAN_AUTHOR と \
         このテストの契約を同時に更新してください"
    );

    let query = bg.selection.query();

    // UI の保存経路: `/api/comments-json` で threads と version を読み、reply を
    // 追記した threads 全量を baseVersion 付きで `/api/comments` へ POST する。
    let fetched = http_get_json(bg.port, &format!("/api/comments-json?{query}"));
    let base_version = fetched["version"].clone();
    let mut threads = fetched["threads"].clone();
    let now = "2026-09-14T00:00:00.000Z";

    // 1) want スレッドへの人間 reply（UI の replyToThread と同じ形）
    let want = &mut threads[0];
    want["updatedAt"] = serde_json::json!(now);
    want["messages"]
        .as_array_mut()
        .expect("messages 配列")
        .push(serde_json::json!({
            "id": "ui-reply-1",
            "body": "これも直して",
            "author": "User",
            "createdAt": now,
            "updatedAt": now,
        }));

    // 2) 人間の新規コメント（UI の addThread と同じ形）。本文は want テンプレート風で、
    //    author が認識されなければ非ブロッキングに誤分類される。
    threads
        .as_array_mut()
        .expect("threads 配列")
        .push(serde_json::json!({
            "id": "ui-human-1",
            "filePath": "README.md",
            "createdAt": now,
            "updatedAt": now,
            "position": {"side": "new", "line": 2},
            "codeSnapshot": {"content": "world"},
            "messages": [{
                "id": "ui-human-1",
                "body": "**💡 want · 🙋 question · ⚡ logic-4** を引用した人間コメント",
                "author": "User",
                "createdAt": now,
                "updatedAt": now,
            }],
        }));

    let saved = http_post_json(
        bg.port,
        &format!("/api/comments?{query}"),
        &serde_json::json!({"threads": threads, "baseVersion": base_version}),
    );
    assert_eq!(saved["success"], true, "UI 経路の保存に失敗: {saved}");

    // 取得時に author が `User` として返る（UI 経路の round-trip 契約）。
    let refetched = http_get_json(bg.port, &format!("/api/comments-json?{query}"));
    let fetched_threads = refetched["threads"].as_array().expect("threads");
    assert_eq!(fetched_threads.len(), 2, "{refetched}");
    assert_eq!(
        fetched_threads[0]["messages"][1]["author"], "User",
        "人間 reply の author が保持される: {refetched}"
    );
    assert_eq!(fetched_threads[0]["messages"][1]["body"], "これも直して");
    assert_eq!(
        fetched_threads[1]["messages"][0]["author"], "User",
        "人間コメントの author が保持される: {refetched}"
    );

    // ゲート: UI 経路の人間 reply で want が昇格し、人間コメントもブロックする。
    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "UI 経路の人間投稿でブロックする: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], false);
    let blocking = json["blocking_threads"]
        .as_array()
        .expect("blocking_threads");
    let promoted = blocking
        .iter()
        .find(|thread| thread["taxonomy"] == "question")
        .expect("人間 reply 付き want が昇格する");
    assert_eq!(
        promoted["replies"][0], "これも直して",
        "人間 reply が修正対象として返る: {json}"
    );
    let human_block = blocking
        .iter()
        .find(|thread| thread["taxonomy"] == "human")
        .expect("人間コメントが human としてブロックする");
    assert_eq!(
        human_block["body"], "**💡 want · 🙋 question · ⚡ logic-4** を引用した人間コメント",
        "author を根拠に want 風の本文でも human として扱う: {json}"
    );

    let state = shared::read_review_state(&path).expect("ブロック時は状態が残る");
    shared::kill_server(state.pid);
}

#[test]
fn test_check_cli_want_only_passes_and_cleans_up() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:2 — consider"
    })];
    let bg = setup_server(&path, &comments);

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(output.status.code(), Some(0));
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));

    assert!(
        !shared::is_process_alive(bg.pid),
        "通過時はサーバを停止する"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "通過時は状態を削除する"
    );
}

#[test]
fn test_check_cli_stale_state_recovers_and_blocks() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale state: 死んだ PID + 未 resolve コメント
    let stale = shared::ReviewState {
        port: 1,
        pid: 2_000_000_000,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[issue] stale recovery test"
        })],
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &stale).unwrap();

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "復旧した未 resolve コメントでブロックする"
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["passes"], false);

    let state = shared::read_review_state(&path).expect("復旧後も状態を保持する");
    assert_ne!(state.pid, stale.pid, "新しいサーバが起動している");
    assert!(shared::is_process_alive(state.pid));

    shared::kill_server(state.pid);
}

#[test]
fn test_check_without_state_errors() {
    let (_tmp, path) = make_temp_git_repo();
    assert!(shared::read_review_state(&path).is_none());

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["difit", "check"])
        .current_dir(&path)
        .output()
        .expect("mt difit check の実行");
    assert!(
        !output.status.success(),
        "状態なしではエラーになること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("difit レビューセッション"),
        "セッションなしの案内が出る"
    );
}

#[cfg(unix)]
#[test]
fn test_check_cli_pid_reuse_recovers_without_killing_unrelated_process() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // PID 再利用の模擬: 生存しているが difit サーバではないプロセスの PID を
    // state に記録する。check は stale として新サーバで自己修復し、この pid を
    // kill してはならない。
    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;

    let stale = shared::ReviewState {
        // difit が応答しないポート。read_review_state の値域検査は通る。
        port: 9,
        pid: victim_pid,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[issue] recovered after pid reuse"
        })],
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &stale).unwrap();

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "PID 再利用でも保存済みコメントで復旧してブロックする"
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["passes"], false);

    assert!(
        shared::is_process_alive(victim_pid),
        "同一性未確認の pid を kill しない"
    );
    let recovered = shared::read_review_state(&path).expect("復旧後の状態が保存される");
    assert_ne!(recovered.pid, victim_pid, "新しいサーバで復旧する");
    assert!(shared::is_process_alive(recovered.pid));

    shared::kill_server(recovered.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

// ---------------------------------------------------------------------------
// サーバ同一性照合（記録 port が応答しても記録 pid がリスナーでなければ kill しない）
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn test_check_cli_does_not_kill_unrelated_pid_when_recorded_port_responds() {
    // 細工した state（または PID 再利用）を模擬: 記録 port では本物の difit が
    // 応答しているが、記録 pid は無関係の生存プロセス。check は保存済みコメントで
    // 復旧するが、この pid を difit 本体と確認できない限り kill してはならない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let running = setup_server(&path, &[]);

    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    let state = shared::ReviewState {
        port: running.port,
        pid: victim_pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(running.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "未 resolve 0 件で通過する: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("停止対象にしません"),
        "同一性未確認で kill をスキップした警告が出る: {stderr}"
    );
    assert!(
        shared::is_process_alive(victim_pid),
        "記録 pid が記録 port の LISTEN でない場合は kill しない"
    );
    assert!(
        shared::is_process_alive(running.pid),
        "記録 port で応答しているサーバも、state 上の同一性が確認できない限り kill しない"
    );

    shared::kill_server(running.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

// ---------------------------------------------------------------------------
// 選択キー防御（ブラウザのリビジョン切替で別セッションを読まない）
// ---------------------------------------------------------------------------

/// ヘルパー: difit サーバの HTTP エンドポイントを GET し、JSON として返す。
fn http_get_json(port: u16, path_and_query: &str) -> serde_json::Value {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let url = format!("http://localhost:{}{}", port, path_and_query);
    let resp = agent
        .get(&url)
        .call()
        .unwrap_or_else(|e| panic!("GET {} が失敗しました: {e}", url));
    resp.into_json().expect("JSON パース")
}

/// ヘルパー: difit サーバの HTTP エンドポイントへ JSON を POST し、応答を返す。
fn http_post_json(port: u16, path_and_query: &str, body: &serde_json::Value) -> serde_json::Value {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let url = format!("http://localhost:{}{}", port, path_and_query);
    let resp = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .unwrap_or_else(|e| panic!("POST {} が失敗しました: {e}", url));
    resp.into_json().expect("JSON パース")
}

/// ヘルパー: 指定リポジトリで git コマンドを実行する（失敗時 panic）。
fn git_cmd(path: &std::path::Path, args: &[&str]) {
    let output = crate::test_support::git_command()
        .args(args)
        .current_dir(path)
        .output()
        .expect("git 実行");
    assert!(
        output.status.success(),
        "git {} が失敗しました: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

#[test]
fn test_check_cli_pins_selection_and_ignores_browser_switch() {
    // 人間がブラウザ UI のリビジョンセレクタで別の選択に切り替えると、difit の
    // currentCommentSelection が上書きされる。選択クエリなしの取得は別セッション
    // （0 件）を読むが、check は起動時に記録した選択に固定して元セッションを読む。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    // merge-base モード: mt difit start main の変換結果（共通フラグ込み）
    let difit_args = crate::difit::start::translate_difit_args(&path, vec!["main".to_string()]);
    assert_eq!(
        difit_args,
        vec![
            ".".to_string(),
            "main".to_string(),
            "--merge-base".to_string(),
            "--clean".to_string(),
            "--include-untracked".to_string()
        ]
    );
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "[issue] pinned selection regression"
    })];
    let server =
        shared::start_difit_server(&path, &difit_args, &comments).expect("difit サーバ起動");
    assert_eq!(
        server.selection.base_mode.as_deref(),
        Some("merge-base"),
        "merge-base 選択が記録される"
    );
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.clone(),
        difit_args: difit_args.clone(),
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    // ブラウザのリビジョン切替を再現: /api/diff を別の選択で呼ぶ
    let head = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let main = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "main"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let switched = http_get_json(server.port, &format!("/api/diff?base={main}&target={head}"));
    assert!(
        switched["requestedBaseMode"].is_null(),
        "切替後は direct 選択になる: {switched:?}"
    );

    // 前提の再現: 選択クエリなしの取得は別セッション（0 件）を読む
    let unpinned = client::fetch_comments(server.port, None).unwrap();
    assert!(
        unpinned.threads.is_empty(),
        "切替後の unpinned 取得は空（脆弱性が成立する前提）"
    );

    // check は起動時の選択に固定して読み、未 resolve を検知してブロックする
    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "ブラウザ選択の切替で無音 pass しない: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["passes"], false);
    assert_eq!(
        json["blocking_threads"][0]["body"],
        "[issue] pinned selection regression"
    );
    assert_eq!(
        json["selection_drift"]["detection"], "detected",
        "通常 check の出力にも選択ドリフトを含める: {json}"
    );
    assert_eq!(
        json["selection_drift"]["expected"]["baseMode"],
        "merge-base"
    );
    assert!(
        json["selection_drift"]["current"].is_object(),
        "現在の選択を併記する: {json}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ブラウザの diff 選択"),
        "選択ドリフトの警告が出る: {stderr}"
    );

    // 元セッションのコメントは state に残り、注入済みコメントは失われない
    let kept = shared::read_review_state(&path).expect("ブロック時は状態が残る");
    assert_eq!(kept.pid, server.pid);
    assert_eq!(kept.comments.len(), 1);
    let pinned = client::fetch_comments(server.port, kept.selection.as_ref()).unwrap();
    assert_eq!(
        pinned.threads.len(),
        1,
        "元セッションのコメントは失われない"
    );

    // 選択切替のまま start で追記しても、固定した元セッションに入る
    let second = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "[context] second round after switch"
    }]);
    let output = run_mt_with_env(&path, &["difit", "start", "main"], &second.to_string(), &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "切替状態でも start の再利用が成功する: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let after = shared::read_review_state(&path).expect("状態が更新される");
    assert_eq!(after.pid, server.pid, "サーバは再利用される");
    assert_eq!(after.comments.len(), 2, "追記は固定した元セッションに入る");
    let pinned_after = client::fetch_comments(server.port, after.selection.as_ref()).unwrap();
    assert_eq!(
        pinned_after.threads.len(),
        2,
        "切替後も元セッションに両方のコメントがある"
    );

    shared::kill_server(server.pid);
}

#[test]
fn test_selection_query_with_special_characters_targets_same_session() {
    // base / target に `&` `=` `%` `+` 空白 `#` を含む選択でも、選択クエリが
    // パーセントエンコードされ、difit の同一セッションへ読み書きできる。
    // エンコードが欠けると `&` 以降が別パラメータとして解釈され、別セッションを
    // 読み書きする（現在の difit は ref を解決済み hash に変換するが、選択キーは
    // どのような文字列でもキーになり得る）。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let server =
        shared::start_difit_server(&path, &["working".to_string()], &[]).expect("difit サーバ起動");

    let selection = client::CommentSelection {
        base: "feature&x=1".to_string(),
        target: "topic +plus%25#frag".to_string(),
        base_mode: Some("merge-base".to_string()),
    };
    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] special selection key"
    });
    client::add_comments(server.port, Some(&selection), &[comment]).expect("特殊文字選択へ注入");

    // 正しくエンコードしたクエリを直接 GET して、注入先セッションを確認する。
    // mt の query() がエンコードを怠ると、ここで別セッション（空）を読む。
    let encoded = "base=feature%26x%3D1&target=topic%20%2Bplus%2525%23frag&baseMode=merge-base";
    let raw = http_get_json(server.port, &format!("/api/comments-json?{encoded}"));
    assert_eq!(
        raw["threads"].as_array().map(Vec::len),
        Some(1),
        "エンコード済みクエリで同一セッションを読める: {raw}"
    );

    let resp = client::fetch_comments(server.port, Some(&selection)).expect("選択固定取得");
    assert_eq!(resp.threads.len(), 1, "mt の読み取りも同じセッションを指す");

    let unpinned = client::fetch_comments(server.port, None).expect("unpinned 取得");
    assert!(
        unpinned.threads.is_empty(),
        "既定セッションへは書かれない: {unpinned:?}"
    );

    shared::kill_server(server.pid);
}

#[test]
fn test_check_without_selection_fails_closed() {
    // 選択キー未記録の state（選択固定前の旧形式）はゲートを判定できない。
    // サーバ・状態を変更せず fail-closed で停止する（無音 pass の防止）。
    let _guard = crate::test_support::difit_test_lock();
    let (_tmp, path) = make_temp_git_repo();

    let state = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 1},
            "body": "[issue] legacy state without selection"
        })],
        difit_args: vec!["working".to_string()],
        selection: None,
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert!(
        !output.status.success(),
        "選択キーなしではゲートを判定しない: stdout={}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("選択キー"),
        "復旧手順が分かるエラーを出す: {stderr}"
    );

    let kept = shared::read_review_state(&path).expect("fail-closed では状態を残す");
    assert_eq!(kept.comments.len(), 1);
    assert!(kept.selection.is_none());
}

// ---------------------------------------------------------------------------
// 非破壊ゲート照会（mt difit check --dry-run）
// ---------------------------------------------------------------------------

#[test]
fn test_check_dry_run_without_state_errors() {
    let (_tmp, path) = make_temp_git_repo();
    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert!(!output.status.success(), "state なしは非 0 exit");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("difit レビューセッション"),
        "セッションなしの案内が出る: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn test_check_dry_run_pass_keeps_server_and_state() {
    // dry-run はゲート判定のみ。通過でもサーバ停止・状態削除・状態書き換えをしない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:2 — consider"
    })];
    let bg = setup_server(&path, &comments);

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "dry-run pass は exit 0: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert_eq!(
        json["selection_drift"]["detection"], "none",
        "ドリフトなしでも検知結果を出力する: {json}"
    );
    assert!(
        json["selection_drift"]["expected"].is_object(),
        "ゲート固定の選択を併記する: {json}"
    );

    assert!(shared::is_process_alive(bg.pid), "サーバを停止しない");
    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(state_before, state_after, "state を変更しない");

    // 参考: 通常 check は同じ状態で通過後に片付ける
    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert_eq!(output.status.code(), Some(0));
    assert!(!shared::is_process_alive(bg.pid));
    assert!(shared::read_review_state(&path).is_none());
}

#[test]
fn test_check_dry_run_block_keeps_state_unchanged() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "🚨 must · 🐛 issue · 🎯 req-1 | README.md:2 — bug"
    })];
    let bg = setup_server(&path, &comments);

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "dry-run はブロックを exit 1 で返す"
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "issue");
    assert_eq!(json["blocking_threads"][0]["body"], comments[0]["body"]);

    assert!(shared::is_process_alive(bg.pid), "サーバを停止しない");
    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(
        state_before, state_after,
        "ブロック時も state.comments を書き換えない"
    );

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_dry_run_does_not_recover_stale_state() {
    // dry-run は stale 復旧（サーバ起動・state 書き換え）も行わない。
    // 復旧が必要な場合は明示エラーで非 0 exit し、無音で判定しない。
    let _guard = crate::test_support::difit_test_lock();
    let (_tmp, path) = make_temp_git_repo();

    let stale = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[issue] stale state"
        })],
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &stale).unwrap();

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert!(
        !output.status.success(),
        "stale state では判定不能を明示エラーにする"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("同一性を確認できません") && stderr.contains("stale"),
        "stale state の診断を出す: {stderr}"
    );
    assert!(
        stderr.contains("mt difit start"),
        "復旧手順が分かるエラーを出す: {stderr}"
    );

    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(state_before, state_after, "復旧も state 書き換えもしない");
}

#[cfg(unix)]
#[test]
fn test_check_dry_run_requires_server_identity() {
    // 記録 port では実 difit が応答しているが、記録 pid はその LISTEN ではない
    // （PID 再利用・細工した state）。照合なしの旧 dry-run は記録 port の
    // 空セッションを読んで passes:true を返し得た。dry-run は非破壊のまま
    // fail-closed で止まり、別プロセスへの誘導で無音 pass しない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let running = setup_server(&path, &[]);

    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    let state = shared::ReviewState {
        port: running.port,
        pid: victim_pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(running.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert!(
        !output.status.success(),
        "同一性未確認では pass しない: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "pass と解釈できる JSON を出さない: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("同一性を確認できません") && stderr.contains("stale"),
        "原因が分かるエラーを出す: {stderr}"
    );

    // read-only: state を変更せず、どのプロセスも停止しない
    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(state_before, state_after, "dry-run は state を変更しない");
    assert!(shared::is_process_alive(running.pid), "サーバを停止しない");
    assert!(
        shared::is_process_alive(victim_pid),
        "無関係プロセスを kill しない"
    );

    shared::kill_server(running.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

#[test]
fn test_check_dry_run_reports_selection_drift() {
    // ブラウザのリビジョン切替（選択ドリフト）を dry-run でも検知し、出力 JSON と
    // stderr で報告する。ゲート判定は state に固定した選択で継続し、サーバ・state・
    // 元セッションのコメントを変更しない（非破壊契約）。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    let difit_args = vec![
        ".".to_string(),
        "main".to_string(),
        "--merge-base".to_string(),
        "--clean".to_string(),
    ];
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "[issue] dry-run drift regression"
    })];
    let server =
        shared::start_difit_server(&path, &difit_args, &comments).expect("difit サーバ起動");
    assert_eq!(
        server.selection.base_mode.as_deref(),
        Some("merge-base"),
        "前提: merge-base 選択が記録される"
    );
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.clone(),
        difit_args,
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    // ブラウザのリビジョン切替を再現: /api/diff を別の選択で呼ぶ
    let head = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let main = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "main"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    http_get_json(server.port, &format!("/api/diff?base={main}&target={head}"));

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "check", "--dry-run"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "固定セッションの issue でブロックする: stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], false);
    assert_eq!(
        json["blocking_threads"][0]["body"], "[issue] dry-run drift regression",
        "判定は固定した元セッションを読む: {json}"
    );
    assert_eq!(
        json["selection_drift"]["detection"], "detected",
        "dry-run でも選択ドリフトを検知する: {json}"
    );
    assert_eq!(
        json["selection_drift"]["expected"]["baseMode"],
        "merge-base"
    );
    assert!(
        json["selection_drift"]["current"].is_object(),
        "サーバが現在返す選択を併記する: {json}"
    );
    assert!(
        json["selection_drift"]["current"]["baseMode"].is_null(),
        "切替後は direct（baseMode なし）: {json}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ブラウザの diff 選択"),
        "選択ドリフトの警告が出る: {stderr}"
    );

    // 非破壊: state はバイト単位で不変、サーバは生存、元セッションのコメントも不変
    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(state_before, state_after, "dry-run は state を変更しない");
    assert!(shared::is_process_alive(server.pid), "サーバを停止しない");
    let pinned_after = client::fetch_comments(server.port, Some(&server.selection)).unwrap();
    assert_eq!(
        pinned_after.threads.len(),
        1,
        "元セッションのコメントは失われない"
    );

    shared::kill_server(server.pid);
}
