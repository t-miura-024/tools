//! `mt difit check` のテスト。
//!
//! 実 difit バイナリを使ったゲート判定の統合テストを含む（完了条件 2, 6）。

use super::*;

/// サーバを起動し、状態を保存するヘルパー。
fn setup_server(
    path: &std::path::Path,
    comments: &[serde_json::Value],
) -> shared::DifitBackgroundOutput {
    let bg = shared::spawn_difit_server(path, &["working".to_string()], comments)
        .expect("difit サーバ起動");
    shared::ensure_difit_dir(path).unwrap();
    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: comments.to_vec(),
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(path, &state).unwrap();
    bg
}

// ---------------------------------------------------------------------------
// 統合テスト: ゲート判定（完了条件 2）
// ---------------------------------------------------------------------------

#[test]
fn test_check_gate_passes_context_only() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[context] this is informational"
    })];

    let bg = setup_server(&path, &comments);

    // ゲート判定: [context] のみ → 通過
    let resp = shared::fetch_comments(bg.port).unwrap();
    assert!(shared::gate_passes(&resp.threads), "[context] のみは通過");

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_gate_blocks_issue() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] bug found"
    })];

    let bg = setup_server(&path, &comments);

    let resp = shared::fetch_comments(bg.port).unwrap();
    assert!(!shared::gate_passes(&resp.threads), "[issue] はブロック");

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_gate_blocks_question() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[question] which approach?"
    })];

    let bg = setup_server(&path, &comments);

    let resp = shared::fetch_comments(bg.port).unwrap();
    assert!(!shared::gate_passes(&resp.threads), "[question] はブロック");

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_gate_blocks_human_comment() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "please fix this"
    })];

    let bg = setup_server(&path, &comments);

    let resp = shared::fetch_comments(bg.port).unwrap();
    assert!(
        !shared::gate_passes(&resp.threads),
        "プレフィックスなしはブロック"
    );

    shared::kill_server(bg.pid);
}

#[test]
fn test_check_gate_passes_after_resolve() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
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
    let resp = shared::fetch_comments(bg.port).unwrap();
    assert!(!shared::gate_passes(&resp.threads));

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

    // resolve 後: [context] のみ → 通過
    let resp_after = shared::fetch_comments(bg.port).unwrap();
    assert!(
        shared::gate_passes(&resp_after.threads),
        "resolve 後は通過すべき"
    );

    shared::kill_server(bg.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: stale 復旧後のゲート判定（完了条件 5）
// ---------------------------------------------------------------------------

#[test]
fn test_check_stale_recovery_then_gate() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[context] stale recovery test"
    })];

    // 起動 → kill で stale 再現
    let bg = setup_server(&path, &comments);
    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));

    // stale 復旧: 保存済みコメントで再起動
    let state = shared::read_review_state(&path).unwrap();
    assert!(!shared::is_process_alive(state.pid));

    let bg2 =
        shared::spawn_difit_server(&path, &state.difit_args, &state.comments).expect("stale 復旧");

    // 復旧後のゲート判定
    let resp = shared::fetch_comments(bg2.port).unwrap();
    assert!(
        shared::gate_passes(&resp.threads),
        "復旧後もゲート判定が動作"
    );

    shared::kill_server(bg2.pid);
}
