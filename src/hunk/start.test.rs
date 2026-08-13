//! `mt hunk start` のテスト。
//!
//! 実 hunk バイナリ（daemon + TUI セッション）を使った統合テストを含む。
//! daemon との競合を避けるため、統合テストは Mutex で直列化する。

use super::*;

// ---------------------------------------------------------------------------
// ユニットテスト: newLine 合成（方針 3）
// ---------------------------------------------------------------------------

#[test]
fn test_synthesize_missing_lines_adds_new_line_1_for_file_level_comment() {
    // 行指定なし（ファイルレベル）エントリに newLine: 1 を合成
    let comments = vec![serde_json::json!({
        "filePath": "README.md",
        "summary": "[issue] file-level comment"
    })];

    let result = synthesize_missing_lines(comments);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["newLine"], 1);
    // 他のフィールドは保持される
    assert_eq!(result[0]["filePath"], "README.md");
    assert_eq!(result[0]["summary"], "[issue] file-level comment");
}

#[test]
fn test_synthesize_missing_lines_preserves_existing_line() {
    // newLine / oldLine を持つエントリは一切変更しない
    let comments = vec![
        serde_json::json!({"filePath": "a.rs", "newLine": 42, "summary": "[issue] new side"}),
        serde_json::json!({"filePath": "b.rs", "oldLine": 7, "summary": "[issue] old side"}),
    ];

    let result = synthesize_missing_lines(comments);

    assert_eq!(result[0]["newLine"], 42);
    assert_eq!(result[0]["oldLine"], serde_json::Value::Null);
    assert_eq!(result[1]["oldLine"], 7);
    assert_eq!(result[1]["newLine"], serde_json::Value::Null);
    // 余計なフィールドが追加されない（キー数が変わらない）
    assert_eq!(result[0].as_object().unwrap().len(), 3);
    assert_eq!(result[1].as_object().unwrap().len(), 3);
}

#[test]
fn test_synthesize_missing_lines_idempotent() {
    let comments = vec![
        serde_json::json!({"filePath": "a.rs", "newLine": 7, "summary": "[issue] anchored"}),
        serde_json::json!({"filePath": "b.rs", "summary": "[issue] file-level"}),
    ];

    let once = synthesize_missing_lines(comments);
    assert_eq!(once[0]["newLine"], 7);
    assert_eq!(once[1]["newLine"], 1);

    let twice = synthesize_missing_lines(once.clone());
    assert_eq!(twice, once, "再適用しても結果が変わらないこと");
}

#[test]
fn test_synthesize_missing_lines_leaves_non_object_entries() {
    let comments = vec![serde_json::json!("not an object")];
    let result = synthesize_missing_lines(comments);
    assert_eq!(result, vec![serde_json::json!("not an object")]);
}

#[test]
fn test_synthesize_missing_lines_empty() {
    let result = synthesize_missing_lines(vec![]);
    assert!(result.is_empty());
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 hunk セッションへのコメント適用
// ---------------------------------------------------------------------------

/// ヘルパー: 一時リポジトリ + hunk TUI セッションを起動し、リポジトリとセッションを返す。
fn setup_hunk_session() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    Option<std::process::Child>,
) {
    let (_tmp, path) = shared::make_temp_git_repo();
    // 差分を作る（diff が空だと TUI が開かない可能性があるため）
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let child = shared::spawn_hunk_session(&path);
    (_tmp, path, child)
}

#[test]
fn test_start_applies_comments_and_writes_state() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path, child) = setup_hunk_session();
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    let comments = vec![
        serde_json::json!({
            "filePath": "README.md",
            "newLine": 2,
            "summary": "[issue] fix this"
        }),
        serde_json::json!({
            "filePath": "README.md",
            "summary": "[question] (want) file-level want"
        }),
    ];

    // stdin からコメントを渡して start を実行
    let input = serde_json::to_string(&comments).unwrap();
    let output = run_mt_hunk_start(&path, &input);
    assert!(
        output.status.success(),
        "start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // stdout が JSON で session / comments を含む
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout が JSON であること");
    assert!(json["session"].as_str().is_some(), "session が含まれる");
    assert_eq!(json["comments"], 2);

    // 状態ファイルが保存される
    let state = shared::read_review_state(&path).expect("状態が保存されている");
    assert_eq!(state.comments.len(), 2);
    assert_eq!(state.comments[0]["newLine"], 2, "既存の行指定は保持される");
    assert_eq!(
        state.comments[1]["newLine"], 1,
        "ファイルレベル指摘は newLine: 1 に合成されている"
    );

    // セッションにコメントが適用されている（AI コメント = agent source）
    let fetched = shared::fetch_comments(&path).expect("コメント取得");
    assert_eq!(fetched.len(), 2);
    assert!(fetched.iter().all(|c| c.source == "agent"));
    assert!(fetched.iter().any(|c| c.body == "[issue] fix this"));
    assert!(
        fetched
            .iter()
            .any(|c| c.body == "[question] (want) file-level want")
    );

    shared::stop_hunk_session(child);
}

#[test]
fn test_start_empty_stdin_writes_state_without_comments() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path, child) = setup_hunk_session();
    let Some(child) = child else {
        eprintln!("SKIP: hunk セッションを起動できませんでした");
        return;
    };

    // 空 stdin → コメントなしで状態のみ保存
    let output = run_mt_hunk_start(&path, "");
    assert!(
        output.status.success(),
        "空 stdin でも start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let state = shared::read_review_state(&path).expect("状態が保存されている");
    assert!(state.comments.is_empty());

    let fetched = shared::fetch_comments(&path).expect("コメント取得");
    assert!(fetched.is_empty(), "コメントは適用されていない");

    shared::stop_hunk_session(child);
}

#[test]
fn test_start_without_session_errors_and_cleans_stale_state() {
    let _guard = shared::HUNK_TEST_LOCK.lock().unwrap();
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale state を再現（セッションなし + 状態ファイルあり）
    shared::write_review_state(
        &path,
        &shared::ReviewState {
            comments: vec![serde_json::json!({"filePath": "README.md", "summary": "stale"})],
        },
    )
    .unwrap();

    let output = run_mt_hunk_start(&path, "");
    assert!(
        !output.status.success(),
        "セッションなしではエラーになること"
    );
    assert!(
        shared::read_review_state(&path).is_none(),
        "stale state が削除されていること"
    );
}

/// 実 `mt` バイナリで `mt hunk start` を実行する（stdin は指定入力）。
fn run_mt_hunk_start(path: &std::path::Path, stdin_input: &str) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let mut child = command
        .args(["hunk", "start"])
        .current_dir(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mt hunk start の実行");

    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin_input.as_bytes())
        .expect("stdin への書き込み");
    child.wait_with_output().expect("mt hunk start の出力")
}
