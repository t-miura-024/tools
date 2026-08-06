//! `mt difit status` のテスト。
//!
//! 完了条件 4: セッション有無・サーバ生存・ポート・difit 起動引数・
//! 注入コメント数の表示と、stale state での警告表示（修復・kill なし）。

use super::*;
use std::path::Path;

/// テスト用に `difit-review.json` を書き込む。
fn write_state(path: &Path, pid: i32, comments: &[serde_json::Value], args: &[&str]) {
    let state = shared::ReviewState {
        port: 43210,
        pid,
        comments: comments.to_vec(),
        difit_args: args.iter().map(|s| s.to_string()).collect(),
    };
    shared::write_review_state(path, &state).unwrap();
}

// ---------------------------------------------------------------------------
// セッションなし
// ---------------------------------------------------------------------------

#[test]
fn test_status_no_session() {
    let (_tmp, path) = shared::make_temp_git_repo();

    let out = render_status(&path);

    assert!(
        out.contains("difit review session: none"),
        "セッションなしを表示する: {out:?}"
    );
}

// ---------------------------------------------------------------------------
// アクティブセッション
// ---------------------------------------------------------------------------

#[test]
fn test_status_active_session() {
    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![
        serde_json::json!({"type": "thread", "filePath": "README.md", "position": {"side": "new", "line": 1}, "body": "[issue] a"}),
        serde_json::json!({"type": "thread", "filePath": "README.md", "position": {"side": "new", "line": 2}, "body": "[context] b"}),
    ];
    // テストプロセス自身は生存しているため、"active" になる。
    write_state(&path, std::process::id() as i32, &comments, &["working"]);

    let out = render_status(&path);

    assert!(out.contains("difit review session: active"), "{out:?}");
    assert!(out.contains("http://localhost:43210"), "{out:?}");
    assert!(out.contains("running"), "{out:?}");
    assert!(out.contains("difit args: working"), "{out:?}");
    assert!(
        out.contains("injected comments: 2"),
        "注入コメント数を表示する: {out:?}"
    );
}

#[test]
fn test_status_active_session_empty_args() {
    let (_tmp, path) = shared::make_temp_git_repo();
    write_state(&path, std::process::id() as i32, &[], &[]);

    let out = render_status(&path);

    assert!(out.contains("difit args: (none)"), "{out:?}");
    assert!(out.contains("injected comments: 0"), "{out:?}");
}

// ---------------------------------------------------------------------------
// stale state（サーバ死）
// ---------------------------------------------------------------------------

#[test]
fn test_status_stale_session_warns_but_keeps_state() {
    let (_tmp, path) = shared::make_temp_git_repo();

    // 短命プロセスを起動して終了させ、確実に死んでいる PID を得る。
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead_pid = child.id() as i32;
    child.wait().unwrap();
    assert!(
        !shared::is_process_alive(dead_pid),
        "前提: プロセスは死んでいる"
    );

    write_state(&path, dead_pid, &[], &["main"]);

    let out = render_status(&path);

    assert!(out.contains("difit review session: stale"), "{out:?}");
    assert!(
        out.contains("warning"),
        "stale state では警告を表示する: {out:?}"
    );
    assert!(out.contains("not running"), "{out:?}");
    assert!(out.contains("difit args: main"), "{out:?}");
    // 状態ファイルは残っている（status は修復・削除を行わない）。
    assert!(
        shared::review_state_path(&path).exists(),
        "status は difit-review.json を削除しない"
    );
}
