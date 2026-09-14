//! `mt difit threads --json` のテスト。
//!
//! 選択固定・読み取り専用・fail-closed の契約を、実 difit バイナリを含めて固定する。

use super::*;
use crate::difit::{client, gate};
use crate::test_support::{make_temp_git_repo, require_difit, run_mt_with_env};

// ---------------------------------------------------------------------------
// ユニットテスト: ThreadView の分類と形状
// ---------------------------------------------------------------------------

fn make_message(id: &str, author: Option<&str>, body: &str) -> gate::Message {
    gate::Message {
        id: id.to_string(),
        author: author.map(str::to_string),
        body: body.to_string(),
    }
}

fn make_thread(id: &str, body: &str) -> gate::Thread {
    gate::Thread {
        id: id.to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 2}),
        messages: vec![make_message("m1", None, body)],
    }
}

#[test]
fn test_thread_view_classifies_ai_issue() {
    let thread = make_thread("t1", "🚨 must · 🐛 issue · 🎯 req-1 | a.txt:2 — bug");
    let view = ThreadView::from_thread(&thread).expect("view");
    assert_eq!(view.id, "t1");
    assert_eq!(view.file_path, "a.txt");
    assert_eq!(view.taxonomy, "issue");
    assert!(view.blocking);
    assert_eq!(view.body, "🚨 must · 🐛 issue · 🎯 req-1 | a.txt:2 — bug");
    assert!(view.author.is_none());
    assert!(view.replies.is_empty());
}

#[test]
fn test_thread_view_classifies_want_without_reply_as_non_blocking() {
    let thread = make_thread("t1", "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — x");
    let view = ThreadView::from_thread(&thread).expect("view");
    assert_eq!(view.taxonomy, "question");
    assert!(!view.blocking, "人間 reply のない want はノンブロッキング");
}

#[test]
fn test_thread_view_promotes_want_with_human_reply() {
    let mut thread = make_thread("t1", "💡 want · 🙋 question · ⚡ logic-4 | a.txt:2 — x");
    thread
        .messages
        .push(make_message("m2", Some("User"), "これも直して"));
    let view = ThreadView::from_thread(&thread).expect("view");
    assert!(view.blocking, "人間 reply 付き want はブロッキングに昇格");
    assert_eq!(view.replies.len(), 1);
    assert_eq!(view.replies[0].author.as_deref(), Some("User"));
    assert_eq!(view.replies[0].body, "これも直して");
}

#[test]
fn test_thread_view_human_author_is_human_even_with_taxonomy_header() {
    let mut thread = make_thread("t1", "");
    thread.messages[0] = make_message(
        "m1",
        Some("user"),
        "🚨 must · 🐛 issue · 🎯 req-1 を引用した人間コメント",
    );
    let view = ThreadView::from_thread(&thread).expect("view");
    assert_eq!(view.taxonomy, "human");
    assert!(view.blocking);
}

#[test]
fn test_thread_view_context_is_non_blocking() {
    let thread = make_thread("t1", "[context] informational");
    let view = ThreadView::from_thread(&thread).expect("view");
    assert_eq!(view.taxonomy, "context");
    assert!(!view.blocking);
}

#[test]
fn test_thread_view_empty_messages_is_skipped() {
    let mut thread = make_thread("t1", "x");
    thread.messages.clear();
    assert!(ThreadView::from_thread(&thread).is_none());
}

// ---------------------------------------------------------------------------
// ユニットテスト: fail-closed（read-only エラー経路）
// ---------------------------------------------------------------------------

#[test]
fn test_read_threads_without_state_errors() {
    let (_tmp, path) = make_temp_git_repo();
    let error = read_threads(&path).expect_err("state なしはエラー");
    assert!(
        error.to_string().contains("レビューセッションがありません"),
        "{error:#}"
    );
}

#[test]
fn test_read_threads_without_selection_fails_closed() {
    let (_tmp, path) = make_temp_git_repo();
    let state = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: None,
    };
    shared::write_review_state(&path, &state).unwrap();

    let error = read_threads(&path).expect_err("選択キーなしはエラー");
    assert!(
        error.to_string().contains("選択キー"),
        "無音で pass しない: {error:#}"
    );
}

#[test]
fn test_read_threads_with_dead_server_errors() {
    let (_tmp, path) = make_temp_git_repo();
    let state = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &state).unwrap();

    let error = read_threads(&path).expect_err("サーバ死はエラー");
    assert!(
        error.to_string().contains("同一性を確認できません"),
        "stale 復旧は行わず fail-closed にする: {error:#}"
    );
    assert!(
        error.to_string().contains("mt difit start"),
        "復旧手順が分かるエラーにする: {error:#}"
    );
}

#[cfg(unix)]
#[test]
fn test_threads_cli_requires_server_identity() {
    // 記録 port では実 difit が応答しているが、記録 pid はその LISTEN ではない。
    // 生存確認だけの旧実装は記録 port の空セッションを読み、passes:true を
    // 返し得た。threads は非破壊のまま fail-closed で止まり、無音 pass しない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let server =
        shared::start_difit_server(&path, &["working".to_string()], &[]).expect("difit サーバ起動");
    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    let state = shared::ReviewState {
        port: server.port,
        pid: victim_pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = run_mt_with_env(&path, &["difit", "threads", "--json"], "", &[]);
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

    // read-only: サーバも無関係プロセスも停止しない
    assert!(shared::is_process_alive(server.pid), "サーバを停止しない");
    assert!(
        shared::is_process_alive(victim_pid),
        "無関係プロセスを kill しない"
    );

    shared::kill_server(server.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

#[test]
fn test_threads_cli_requires_json_flag() {
    let (_tmp, path) = make_temp_git_repo();
    let output = run_mt_with_env(&path, &["difit", "threads"], "", &[]);
    assert!(!output.status.success(), "--json なしはエラー");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--json"),
        "案内が出る: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn test_threads_cli_without_state_errors_without_silent_pass() {
    let (_tmp, path) = make_temp_git_repo();
    let output = run_mt_with_env(&path, &["difit", "threads", "--json"], "", &[]);
    assert!(!output.status.success(), "state なしは非 0 exit");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("レビューセッションがありません"),
        "原因が分かるエラーを出す: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "pass と解釈できる JSON を出さない: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 difit サーバでの選択固定・読み取り専用
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

/// ヘルパー: 一時リポジトリで git コマンドを実行する（失敗時 panic）。
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

/// ヘルパー: merge-base 選択でサーバを起動し、選択キーつき状態を保存する。
fn setup_feature_session(
    path: &std::path::Path,
    comments: &[serde_json::Value],
) -> shared::StartedServer {
    let difit_args = vec![
        ".".to_string(),
        "main".to_string(),
        "--merge-base".to_string(),
        "--clean".to_string(),
    ];
    let server = shared::start_difit_server(path, &difit_args, comments).expect("difit サーバ起動");
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.to_vec(),
        difit_args,
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(path, &state).unwrap();
    server
}

#[test]
fn test_threads_cli_reads_pinned_selection_and_is_read_only() {
    // 人間がブラウザ UI で別の選択に切り替えても、threads は state の選択に
    // 固定して元セッション（未 resolve スレッド）を読む。state / サーバを変更しない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    let comments = vec![
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 3},
            "body": "🚨 must · 🐛 issue · 🎯 req-1 | README.md:3 — bug"
        }),
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 3},
            "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:3 — consider"
        }),
    ];
    let server = setup_feature_session(&path, &comments);

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

    // 前提の再現: unpinned 取得は別セッション（0 件）を読む
    let unpinned = client::fetch_comments(server.port, None).unwrap();
    assert!(unpinned.threads.is_empty(), "脆弱性が成立する前提");

    let state_path = shared::review_state_path(&path);
    let state_before = std::fs::read_to_string(&state_path).expect("state 読み取り");

    let output = run_mt_with_env(&path, &["difit", "threads", "--json"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "threads は成功する: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");

    // 固定選択で元セッションの未 resolve スレッドを読む（issue がブロック）
    assert_eq!(json["passes"], false);
    assert_eq!(json["selection"]["baseMode"], "merge-base");
    assert_eq!(
        json["selection_drift"]["detection"], "detected",
        "ブラウザ切替による選択ドリフトを報告する: {json}"
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
    let threads = json["threads"].as_array().expect("threads 配列");
    assert_eq!(threads.len(), 2, "未 resolve スレッド全件: {threads:?}");
    let issue = threads
        .iter()
        .find(|t| t["body"].as_str().unwrap().contains("🐛 issue"))
        .expect("issue スレッド");
    assert_eq!(issue["taxonomy"], "issue");
    assert_eq!(issue["blocking"], true);
    assert_eq!(issue["filePath"], "README.md");
    assert_eq!(issue["position"]["line"], 3);
    let want = threads
        .iter()
        .find(|t| t["body"].as_str().unwrap().contains("💡 want"))
        .expect("want スレッド");
    assert_eq!(want["blocking"], false, "want はノンブロッキング");

    // blocking_threads は mt difit check と同一形状
    let blocking = json["blocking_threads"]
        .as_array()
        .expect("blocking_threads");
    assert_eq!(blocking.len(), 1);
    assert_eq!(blocking[0]["file"], "README.md");
    assert_eq!(blocking[0]["taxonomy"], "issue");

    // 読み取り専用: state はバイト単位で不変、サーバは生存し続ける
    let state_after = std::fs::read_to_string(&state_path).expect("state 読み取り");
    assert_eq!(state_before, state_after, "state を変更しない");
    assert!(shared::is_process_alive(server.pid), "サーバを止めない");
    let pinned = client::fetch_comments(server.port, Some(&server.selection)).unwrap();
    assert_eq!(
        pinned.threads.len(),
        2,
        "元セッションのコメントは失われない"
    );

    shared::kill_server(server.pid);
}

#[test]
fn test_threads_cli_promotes_want_with_human_reply() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:3 — consider"
    })];
    let server = setup_feature_session(&path, &comments);

    // 人間 reply（difit UI は author: "User" を付ける）→ want がブロッキングに昇格
    let reply = serde_json::json!({
        "type": "reply",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "これも直して",
        "author": "User"
    });
    client::add_comments(server.port, Some(&server.selection), &[reply]).expect("reply 追加");

    let output = run_mt_with_env(&path, &["difit", "threads", "--json"], "", &[]);
    assert_eq!(output.status.code(), Some(0));
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");

    assert_eq!(json["passes"], false, "人間 reply 付き want はブロック");
    assert_eq!(json["blocking_threads"][0]["replies"][0], "これも直して");
    assert_eq!(json["threads"][0]["replies"][0]["author"], "User");
    assert_eq!(json["threads"][0]["replies"][0]["body"], "これも直して");

    shared::kill_server(server.pid);
}

#[test]
fn test_threads_cli_passes_with_want_only_and_keeps_session() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "💡 want · 🙋 question · ⚡ logic-4 | README.md:3 — consider"
    })];
    let server = setup_feature_session(&path, &comments);

    let output = run_mt_with_env(&path, &["difit", "threads", "--json"], "", &[]);
    assert_eq!(output.status.code(), Some(0));
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], true);
    assert_eq!(
        json["selection_drift"]["detection"], "none",
        "ドリフトなしでも検知結果を出力する: {json}"
    );
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert_eq!(json["threads"].as_array().unwrap().len(), 1);
    assert!(
        shared::is_process_alive(server.pid),
        "pass でも threads はセッションを消費しない"
    );

    shared::kill_server(server.pid);
}
