use super::*;

// ---------------------------------------------------------------------------
// is_want
// ---------------------------------------------------------------------------

#[test]
fn test_is_want_question_with_want() {
    assert!(is_want("[question] (want) consider this"));
}

#[test]
fn test_is_want_question_should_not_want() {
    assert!(!is_want("[question] (should) fix this"));
}

#[test]
fn test_is_want_issue_not_want() {
    assert!(!is_want("[issue] bug found"));
}

#[test]
fn test_is_want_plain_body_not_want() {
    assert!(!is_want("please fix this"));
}

#[test]
fn test_is_want_want_without_question_prefix() {
    assert!(!is_want("(want) no prefix"));
}

#[test]
fn test_is_want_leading_whitespace() {
    assert!(is_want("  [question] (want) indented"));
}

#[test]
fn test_is_want_empty() {
    assert!(!is_want(""));
}

// ---------------------------------------------------------------------------
// gate_passes（完了条件 3）
// ---------------------------------------------------------------------------

fn agent_comment(body: &str) -> HunkComment {
    HunkComment {
        note_id: "mcp:test:0".to_string(),
        source: "agent".to_string(),
        file_path: "a.txt".to_string(),
        body: body.to_string(),
        old_range: None,
        new_range: Some([1, 1]),
    }
}

fn user_comment(body: &str) -> HunkComment {
    HunkComment {
        note_id: "user:test-1".to_string(),
        source: "user".to_string(),
        file_path: "a.txt".to_string(),
        body: body.to_string(),
        old_range: None,
        new_range: Some([1, 1]),
    }
}

#[test]
fn test_gate_passes_empty_comments() {
    assert!(gate_passes(&[]));
}

#[test]
fn test_gate_blocks_agent_issue() {
    let comments = vec![agent_comment("[issue] bug found")];
    assert!(!gate_passes(&comments));
}

#[test]
fn test_gate_blocks_agent_question_should() {
    let comments = vec![agent_comment("[question] (should) fix this")];
    assert!(!gate_passes(&comments));
}

#[test]
fn test_gate_passes_agent_want() {
    // want 指摘はノンブロッキング（完了条件 3）
    let comments = vec![agent_comment("[question] (want) consider this")];
    assert!(gate_passes(&comments));
}

#[test]
fn test_gate_blocks_user_comment() {
    // 人間コメント残存 = ブロック（完了条件 3）
    let comments = vec![user_comment("please fix this")];
    assert!(!gate_passes(&comments));
}

#[test]
fn test_gate_blocks_user_comment_even_with_any_prefix() {
    let comments = vec![user_comment("[issue] human says")];
    assert!(!gate_passes(&comments));
}

#[test]
fn test_gate_blocks_mixed() {
    let comments = vec![
        agent_comment("[question] (want) ok"),
        user_comment("my note"),
    ];
    assert!(!gate_passes(&comments));
}

#[test]
fn test_gate_passes_all_want() {
    let comments = vec![
        agent_comment("[question] (want) a"),
        agent_comment("[question] (want) b"),
    ];
    assert!(gate_passes(&comments));
}

#[test]
fn test_gate_unknown_source_blocks_unless_want() {
    // source が "ai" 等の未知の値でも AI コメント扱い（want 以外はブロック）
    let mut comment = agent_comment("[issue] future source");
    comment.source = "ai".to_string();
    assert!(!gate_passes(&[comment]));

    let mut want = agent_comment("[question] (want) future want");
    want.source = "ai".to_string();
    assert!(gate_passes(&[want]));
}

// ---------------------------------------------------------------------------
// HunkComment のデシリアライズ（hunk session comment list --json 実出力形式）
// ---------------------------------------------------------------------------

#[test]
fn test_hunk_comment_deserialize_agent() {
    let json = r#"{
        "noteId": "mcp:abc:0",
        "source": "agent",
        "filePath": "README.md",
        "hunkIndex": 0,
        "newRange": [2, 2],
        "body": "[issue] fix this",
        "createdAt": "2026-08-13T00:00:00.000Z",
        "editable": false
    }"#;
    let comment: HunkComment = serde_json::from_str(json).unwrap();
    assert_eq!(comment.note_id, "mcp:abc:0");
    assert_eq!(comment.source, "agent");
    assert_eq!(comment.file_path, "README.md");
    assert_eq!(comment.body, "[issue] fix this");
    assert_eq!(comment.new_range, Some([2, 2]));
    assert_eq!(comment.old_range, None);
}

#[test]
fn test_hunk_comment_deserialize_user_with_old_range() {
    let json = r#"{
        "noteId": "user:1786538401705-1",
        "source": "user",
        "filePath": "a.txt",
        "hunkIndex": 0,
        "oldRange": [7, 7],
        "body": "human note",
        "author": "user",
        "createdAt": "2026-08-12T12:40:01.705Z",
        "editable": true
    }"#;
    let comment: HunkComment = serde_json::from_str(json).unwrap();
    assert_eq!(comment.source, "user");
    assert_eq!(comment.old_range, Some([7, 7]));
    assert_eq!(comment.new_range, None);
}

// ---------------------------------------------------------------------------
// ReviewState JSON シリアライズ
// ---------------------------------------------------------------------------

#[test]
fn test_review_state_roundtrip() {
    let state = ReviewState {
        comments: vec![serde_json::json!({
            "filePath": "README.md",
            "newLine": 2,
            "summary": "[issue] test"
        })],
    };
    let json = serde_json::to_string(&state).unwrap();
    let parsed: ReviewState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.comments.len(), 1);
    assert_eq!(parsed.comments[0]["filePath"], "README.md");
}

// ---------------------------------------------------------------------------
// .hunk/ ディレクトリ & 状態ファイル
// ---------------------------------------------------------------------------

#[test]
fn test_ensure_hunk_dir_idempotent() {
    let (_tmp, path) = make_temp_git_repo();
    ensure_hunk_dir(&path).unwrap();
    assert!(hunk_dir(&path).exists());
    // 自己 .gitignore が生成される
    assert!(hunk_dir(&path).join(".gitignore").exists());
    // 2 回呼んでもエラーにならない
    ensure_hunk_dir(&path).unwrap();
    assert!(hunk_dir(&path).exists());
}

#[test]
fn test_review_state_write_read_delete() {
    let (_tmp, path) = make_temp_git_repo();
    let state = ReviewState { comments: vec![] };

    assert!(read_review_state(&path).is_none());

    write_review_state(&path, &state).unwrap();
    let loaded = read_review_state(&path).expect("state should exist");
    assert!(loaded.comments.is_empty());

    delete_review_state(&path);
    assert!(read_review_state(&path).is_none());
}

#[test]
fn test_git_repo_root_in() {
    let (_tmp, path) = make_temp_git_repo();
    let sub = path.join("subdir");
    std::fs::create_dir_all(&sub).unwrap();
    let root = git_repo_root_in(&sub).unwrap();
    assert_eq!(root, path.canonicalize().unwrap());
}
