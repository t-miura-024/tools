//! `mt difit done` のテスト。

use super::*;
use std::process::Command;

fn setup_server(
    path: &std::path::Path,
    comments: &[serde_json::Value],
) -> shared::DifitBackgroundOutput {
    let bg = shared::spawn_difit_server(path, &["working".to_string()], comments)
        .expect("difit サーバ起動");
    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: comments.to_vec(),
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(path, &state).unwrap();
    bg
}

fn output_json(output: &check::CheckOutput) -> serde_json::Value {
    serde_json::to_value(output).unwrap()
}

#[test]
fn test_done_passes_and_cleans_up_live_server() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 1},
        "body": "[context] informational"
    })];
    let bg = setup_server(&path, &comments);

    let output = done_in(&path).expect("done が成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert!(!shared::is_process_alive(bg.pid), "サーバが停止すること");
    assert!(
        shared::read_review_state(&path).is_none(),
        "状態が削除されること"
    );
}

#[test]
fn test_done_blocks_but_still_cleans_up_and_returns_success_result() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 1},
        "body": "[issue] must fix"
    })];
    let bg = setup_server(&path, &comments);

    // ブロック結果でも done_in はエラーにせず、後片付けまで完了する。
    let output = done_in(&path).expect("ブロックしても done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"][0]["taxonomy"], "issue");
    assert!(
        !shared::is_process_alive(bg.pid),
        "ブロック時もサーバが停止すること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "ブロック時も状態が削除されること"
    );
}

#[test]
fn test_done_recovers_stale_state_then_cleans_up_recovered_server() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 1},
        "body": "[context] stale state"
    })];
    let stale = setup_server(&path, &comments);
    shared::kill_server(stale.pid);
    assert!(!shared::is_process_alive(stale.pid));

    let (output, cleanup_pid) =
        done_in_with_cleanup_pid(&path).expect("stale state から復旧して done できること");
    let json = output_json(&output);
    assert_eq!(json["passes"], true);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    let recovered_pid = cleanup_pid.expect("復旧後サーバの PID が記録されること");
    assert_ne!(recovered_pid, stale.pid, "復旧後は新しいサーバであること");
    assert!(
        !shared::is_process_alive(recovered_pid),
        "done 後に復旧後サーバも停止すること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "stale 状態も削除されること"
    );
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
fn test_done_returns_json_result_when_comment_fetch_fails() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let bg =
        shared::spawn_difit_server(&path, &["working".to_string()], &[]).expect("difit サーバ起動");
    let state = shared::ReviewState {
        // サーバは生きているが、このポートには comment get の応答元がない。
        port: 0,
        pid: bg.pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = done_in(&path).expect("コメント取得失敗でも done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert!(
        !shared::is_process_alive(bg.pid),
        "取得失敗時もサーバを停止すること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "状態を削除すること"
    );
}

#[test]
fn test_done_returns_json_result_when_stale_recovery_fails() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let bg =
        shared::spawn_difit_server(&path, &["working".to_string()], &[]).expect("difit サーバ起動");
    shared::kill_server(bg.pid);

    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: Vec::new(),
        difit_args: vec!["--not-a-real-difit-option".to_string()],
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = done_in(&path).expect("stale 復旧失敗でも done は成功すること");
    let json = output_json(&output);
    assert_eq!(json["passes"], false);
    assert_eq!(json["blocking_threads"], serde_json::json!([]));
    assert!(
        shared::read_review_state(&path).is_none(),
        "復旧失敗時も状態を削除すること"
    );
}

#[test]
fn test_done_public_entrypoint_returns_success_and_cleans_up() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 1},
        "body": "[context] public entrypoint"
    })];
    let bg = setup_server(&path, &comments);

    let original_dir = std::env::current_dir().unwrap();
    std::env::set_current_dir(&path).unwrap();
    let result = done();
    std::env::set_current_dir(original_dir).unwrap();

    assert!(result.is_ok(), "公開 done() は exit 0 相当で完了すること");
    assert!(
        !shared::is_process_alive(bg.pid),
        "公開経路でもサーバを停止すること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "公開経路でも状態を削除すること"
    );
}

#[test]
fn test_done_cli_exits_zero_and_prints_json_schema() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 1},
        "body": "[issue] CLI path must exit successfully"
    })];
    let bg = setup_server(&path, &comments);

    let mut command = Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["difit", "done"])
        .current_dir(&path)
        .output()
        .expect("mt difit done の実行");

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
        !shared::is_process_alive(bg.pid),
        "CLI 経路でもサーバを停止すること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "CLI 経路でも状態を削除すること"
    );
}
