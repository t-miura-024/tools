//! `mt hunk done` のテスト。

use super::*;
use std::process::Command;

fn output_json(output: &check::CheckOutput) -> serde_json::Value {
    serde_json::to_value(output).unwrap()
}

#[test]
fn test_done_passes_and_cleans_up_state() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    // want のみ → 通過
    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[question] (want) informational"
    })];
    shared::apply_comments(&path, &comments).unwrap();
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: comments.clone(),
        },
    )
    .unwrap();

    let output = done_in(&path).expect("done が成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert!(
        shared::read_review_state(&path).is_none(),
        "状態が削除されること"
    );

    shared::stop_hunk_session(child);
}

#[test]
fn test_done_blocks_but_still_cleans_up_and_returns_success_result() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[issue] must fix"
    })];
    shared::apply_comments(&path, &comments).unwrap();
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: comments.clone(),
        },
    )
    .unwrap();

    // ブロック結果でも done_in はエラーにせず、後片付けまで完了する。
    let output = done_in(&path).expect("ブロックしても done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "issue");
    assert!(
        shared::read_review_state(&path).is_none(),
        "ブロック時も状態が削除されること"
    );

    shared::stop_hunk_session(child);
}

#[test]
fn test_done_without_state_is_idempotent() {
    let (_tmp, path) = shared::make_temp_git_repo();

    let output = done_in(&path).expect("状態がなくても done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert!(shared::read_review_state(&path).is_none());
}

#[test]
fn test_done_stale_state_cleans_up() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    if !shared::hunk_available() {
        eprintln!("SKIP: hunk がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale state: 状態ファイルのみ（セッションなし）
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: vec![serde_json::json!({
                "filePath": "README.md",
                "newLine": 2,
                "summary": "[issue] lost"
            })],
        },
    )
    .unwrap();

    let output = done_in(&path).expect("stale でも done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], true, "コメントが消えているので通過");
    assert!(
        shared::read_review_state(&path).is_none(),
        "stale 状態が削除されること"
    );
}

#[test]
fn test_done_cli_exits_zero_and_prints_json_schema() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[issue] CLI path must exit successfully"
    })];
    shared::apply_comments(&path, &comments).unwrap();
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: comments.clone(),
        },
    )
    .unwrap();

    let mut command = Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["hunk", "done"])
        .current_dir(&path)
        .output()
        .expect("mt hunk done の実行");

    assert!(
        output.status.success(),
        "ブロック結果でも CLI は exit 0 で終了すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout が JSON としてパースできること");
    let object = json
        .as_object()
        .expect("stdout が JSON オブジェクトであること");
    assert_eq!(object.len(), 2, "stdout が done の JSON スキーマであること");
    assert_eq!(json["passes"], false);
    assert!(json["blocking_threads"].is_array());
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "issue");
    assert!(
        shared::read_review_state(&path).is_none(),
        "CLI 経路でも状態を削除すること"
    );

    shared::stop_hunk_session(child);
}
