//! `mt hunk status` のテスト。
//!
//! セッション有無・hunk セッションの生存・適用済みコメント数の表示と、
//! stale state での警告表示（修復・削除なし）。

use super::*;
use std::path::Path;

/// テスト用に `hunk-review.json` を書き込む。
fn write_state(path: &Path, comments: &[serde_json::Value]) {
    let state = shared::ReviewState {
        comments: comments.to_vec(),
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
        out.contains("hunk review session: none"),
        "セッションなしを表示する: {out:?}"
    );
}

// ---------------------------------------------------------------------------
// アクティブセッション
// ---------------------------------------------------------------------------

#[test]
fn test_status_active_session() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let comments = vec![
        serde_json::json!({"filePath": "README.md", "newLine": 1, "summary": "[issue] a"}),
        serde_json::json!({"filePath": "README.md", "newLine": 2, "summary": "[question] (want) b"}),
    ];
    write_state(&path, &comments);

    let out = render_status(&path);

    assert!(out.contains("hunk review session: active"), "{out:?}");
    assert!(
        out.contains("applied comments: 2"),
        "適用コメント数を表示する: {out:?}"
    );

    shared::stop_hunk_session(child);
}

#[test]
fn test_status_active_session_zero_comments() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    write_state(&path, &[]);

    let out = render_status(&path);

    assert!(out.contains("hunk review session: active"), "{out:?}");
    assert!(out.contains("applied comments: 0"), "{out:?}");

    shared::stop_hunk_session(child);
}

// ---------------------------------------------------------------------------
// stale state（セッションなし）
// ---------------------------------------------------------------------------

#[test]
fn test_status_stale_session_warns_but_keeps_state() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    if !shared::hunk_available() {
        eprintln!("SKIP: hunk がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    write_state(
        &path,
        &[serde_json::json!({"filePath": "README.md", "summary": "[issue] lost"})],
    );

    let out = render_status(&path);

    assert!(out.contains("hunk review session: stale"), "{out:?}");
    assert!(
        out.contains("warning"),
        "stale state では警告を表示する: {out:?}"
    );
    // 状態ファイルは残っている（status は修復・削除を行わない）。
    assert!(
        shared::review_state_path(&path).exists(),
        "status は hunk-review.json を削除しない"
    );
}
