//! `mt hunk check` のテスト。
//!
//! 実 hunk バイナリを使ったゲート判定の統合テストを含む（完了条件 3）。

use super::*;

// ---------------------------------------------------------------------------
// ユニットテスト: output_for_comments
// ---------------------------------------------------------------------------

fn agent_comment(body: &str) -> shared::HunkComment {
    shared::HunkComment {
        note_id: "mcp:test:0".to_string(),
        source: "agent".to_string(),
        file_path: "a.txt".to_string(),
        body: body.to_string(),
        old_range: None,
        new_range: Some([2, 2]),
    }
}

fn user_comment(body: &str) -> shared::HunkComment {
    shared::HunkComment {
        note_id: "user:test-1".to_string(),
        source: "user".to_string(),
        file_path: "a.txt".to_string(),
        body: body.to_string(),
        old_range: Some([3, 3]),
        new_range: None,
    }
}

#[test]
fn test_output_for_empty_comments_passes() {
    let out = output_for_comments(&[]);
    assert!(out.passes);
    assert!(out.blocking_threads.is_empty());
}

#[test]
fn test_output_for_want_comment_passes() {
    let out = output_for_comments(&[agent_comment("[question] (want) consider")]);
    assert!(out.passes, "want はノンブロッキング");
    assert!(out.blocking_threads.is_empty());
}

#[test]
fn test_output_for_issue_comment_blocks_with_taxonomy() {
    let out = output_for_comments(&[agent_comment("[issue] bug")]);
    assert!(!out.passes);
    assert_eq!(out.blocking_threads.len(), 1);
    let blocking = &out.blocking_threads[0];
    assert_eq!(blocking.taxonomy, "issue");
    assert_eq!(blocking.id, "mcp:test:0");
    assert_eq!(blocking.file, "a.txt");
    assert_eq!(blocking.line, Some(2));
    assert_eq!(blocking.body, "[issue] bug");
    assert!(blocking.replies.is_empty());
}

#[test]
fn test_output_for_question_comment_blocks_with_taxonomy() {
    let out = output_for_comments(&[agent_comment("[question] which approach?")]);
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "question");
}

#[test]
fn test_output_for_agent_comment_without_prefix_blocks_as_question() {
    let out = output_for_comments(&[agent_comment("no prefix")]);
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "question");
}

#[test]
fn test_output_for_user_comment_blocks_as_human() {
    let out = output_for_comments(&[user_comment("please fix")]);
    assert!(!out.passes);
    let blocking = &out.blocking_threads[0];
    assert_eq!(blocking.taxonomy, "human");
    assert_eq!(blocking.id, "user:test-1");
    assert_eq!(blocking.line, Some(3), "oldRange の先頭が使われる");
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 hunk セッションでのゲート判定（完了条件 3）
// ---------------------------------------------------------------------------

/// ヘルパー: 一時リポジトリ + hunk TUI セッションを起動し、コメントを適用する。
fn setup_with_comments(
    comments: &[serde_json::Value],
) -> (
    tempfile::TempDir,
    std::path::PathBuf,
    Option<std::process::Child>,
) {
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    if child.is_some() {
        shared::apply_comments(&path, comments).expect("コメント適用");
    }
    (_tmp, path, child)
}

#[test]
fn test_check_gate_blocks_issue_comment() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[issue] bug found"
    })];
    let (_tmp, path, child) = setup_with_comments(&comments);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let out = output_for_comments(&shared::fetch_comments(&path).unwrap());
    assert!(!out.passes, "[issue] はブロック");

    shared::stop_hunk_session(child);
}

#[test]
fn test_check_gate_blocks_user_comment() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    // user コメントは TUI 経由でしか追加できないため、構造体を直接構築して
    // ゲート判定（gate_passes / output_for_comments）のロジックを検証する。
    let comments = vec![user_comment("human note")];
    assert!(!shared::gate_passes(&comments));
    let out = output_for_comments(&comments);
    assert!(!out.passes);
    assert_eq!(out.blocking_threads[0].taxonomy, "human");
}

#[test]
fn test_check_gate_passes_want_comment() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[question] (want) consider this"
    })];
    let (_tmp, path, child) = setup_with_comments(&comments);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let out = output_for_comments(&shared::fetch_comments(&path).unwrap());
    assert!(out.passes, "want はノンブロッキング（完了条件 3）");
    assert!(out.blocking_threads.is_empty());

    shared::stop_hunk_session(child);
}

#[test]
fn test_check_gate_passes_after_rm() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "newLine": 2,
        "summary": "[issue] problem"
    })];
    let (_tmp, path, child) = setup_with_comments(&comments);
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    // 初期状態: [issue] あり → ブロック
    let fetched = shared::fetch_comments(&path).unwrap();
    assert!(!shared::gate_passes(&fetched));

    // AI コメントの rm = 解決 → 通過（完了条件 3）
    let issue = fetched
        .iter()
        .find(|c| c.body == "[issue] problem")
        .unwrap();
    let rm_output = crate::git::common::command_with_clean_git_context("hunk")
        .args(["session", "comment", "rm", "--repo"])
        .arg(path.as_os_str())
        .arg(&issue.note_id)
        .output()
        .expect("rm 実行");
    assert!(rm_output.status.success(), "rm が成功すること");

    let after = shared::fetch_comments(&path).unwrap();
    assert!(
        shared::gate_passes(&after),
        "rm 後は通過すべき（完了条件 3）"
    );

    shared::stop_hunk_session(child);
}

#[test]
fn test_check_without_state_errors() {
    let (_tmp, path) = shared::make_temp_git_repo();
    assert!(shared::read_review_state(&path).is_none());

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["hunk", "check"])
        .current_dir(&path)
        .output()
        .expect("mt hunk check の実行");
    assert!(
        !output.status.success(),
        "状態なしではエラーになること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn test_check_stale_state_self_repairs() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    if !shared::hunk_available() {
        eprintln!("SKIP: hunk がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale state を再現: 状態ファイルのみ（セッションなし）
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: vec![serde_json::json!({
                "filePath": "README.md",
                "newLine": 2,
                "summary": "[issue] lost comment"
            })],
        },
    )
    .unwrap();

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["hunk", "check"])
        .current_dir(&path)
        .output()
        .expect("mt hunk check の実行");

    // 自己修復: 通過 + 状態ファイル削除
    assert!(
        output.status.success(),
        "stale は修復して通過すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["passes"], true);
    assert!(
        shared::read_review_state(&path).is_none(),
        "stale 状態が削除されていること"
    );
}
