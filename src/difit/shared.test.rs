use super::*;

// ---------------------------------------------------------------------------
// classify_body
// ---------------------------------------------------------------------------

#[test]
fn test_classify_body_issue() {
    assert_eq!(classify_body("[issue] something wrong"), Taxonomy::Issue);
}

#[test]
fn test_classify_body_question() {
    assert_eq!(classify_body("[question] should we do X?"), Taxonomy::Question);
}

#[test]
fn test_classify_body_context() {
    assert_eq!(classify_body("[context] this is background info"), Taxonomy::Context);
}

#[test]
fn test_classify_body_human_no_prefix() {
    assert_eq!(classify_body("I think this is fine"), Taxonomy::Human);
}

#[test]
fn test_classify_body_leading_whitespace() {
    assert_eq!(classify_body("  [issue] indented"), Taxonomy::Issue);
}

#[test]
fn test_classify_body_empty() {
    assert_eq!(classify_body(""), Taxonomy::Human);
}

// ---------------------------------------------------------------------------
// is_blocking
// ---------------------------------------------------------------------------

#[test]
fn test_is_blocking_issue() {
    assert!(is_blocking(Taxonomy::Issue));
}

#[test]
fn test_is_blocking_question() {
    assert!(is_blocking(Taxonomy::Question));
}

#[test]
fn test_is_blocking_human() {
    assert!(is_blocking(Taxonomy::Human));
}

#[test]
fn test_is_blocking_context_not_blocking() {
    assert!(!is_blocking(Taxonomy::Context));
}

// ---------------------------------------------------------------------------
// gate_passes
// ---------------------------------------------------------------------------

fn make_thread(body: &str) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![Message {
            id: "m1".to_string(),
            body: body.to_string(),
        }],
    }
}

fn make_thread_with_reply(parent_body: &str, reply_body: &str) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![
            Message {
                id: "m1".to_string(),
                body: parent_body.to_string(),
            },
            Message {
                id: "m2".to_string(),
                body: reply_body.to_string(),
            },
        ],
    }
}

#[test]
fn test_gate_passes_empty_threads() {
    assert!(gate_passes(&[]));
}

#[test]
fn test_gate_passes_context_only() {
    let threads = vec![make_thread("[context] FYI")];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_passes_multiple_context() {
    let threads = vec![
        make_thread("[context] info 1"),
        make_thread("[context] info 2"),
    ];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_blocks_issue() {
    let threads = vec![make_thread("[issue] bug found")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_question() {
    let threads = vec![make_thread("[question] which approach?")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_human_comment() {
    let threads = vec![make_thread("please fix this")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_mixed_with_issue() {
    let threads = vec![
        make_thread("[context] info"),
        make_thread("[issue] problem"),
    ];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_uses_parent_body_not_reply() {
    // 親が [context]、reply が [issue] でもゲートは通過する
    // （ゲート判定はスレッド親の body のみ）
    let threads = vec![make_thread_with_reply("[context] info", "[issue] reply issue")];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_blocks_parent_issue_with_reply() {
    let threads = vec![make_thread_with_reply("[issue] problem", "I agree")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_thread_with_no_messages() {
    let thread = Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![],
    };
    assert!(gate_passes(&[thread]));
}

// ---------------------------------------------------------------------------
// threads_to_import_comments（方針 4: 形式変換）
// ---------------------------------------------------------------------------

#[test]
fn test_threads_to_import_comments_single_thread() {
    let threads = vec![make_thread("[issue] bug")];
    let comments = threads_to_import_comments(&threads);
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["type"], "thread");
    assert_eq!(comments[0]["id"], "t1");
    assert_eq!(comments[0]["body"], "[issue] bug");
    assert_eq!(comments[0]["filePath"], "a.txt");
}

#[test]
fn test_threads_to_import_comments_thread_with_reply() {
    let threads = vec![make_thread_with_reply("[issue] bug", "will fix")];
    let comments = threads_to_import_comments(&threads);
    assert_eq!(comments.len(), 2);

    assert_eq!(comments[0]["type"], "thread");
    assert_eq!(comments[0]["id"], "t1");
    assert_eq!(comments[0]["body"], "[issue] bug");

    // reply は filePath + position で親スレッドにマッチされる（parentId はスキーマ外）
    assert_eq!(comments[1]["type"], "reply");
    assert_eq!(comments[1]["filePath"], "a.txt");
    assert_eq!(comments[1]["position"]["side"], "new");
    assert_eq!(comments[1]["position"]["line"], 1);
    assert_eq!(comments[1]["body"], "will fix");
    assert!(comments[1].get("parentId").is_none(), "parentId はスキーマ外のため出力しない");
}

#[test]
fn test_threads_to_import_comments_preserves_id() {
    // 方針 5: id フィールドを指定してスレッド ID を維持
    let threads = vec![make_thread("[context] info")];
    let comments = threads_to_import_comments(&threads);
    assert_eq!(comments[0]["id"], "t1");
}

#[test]
fn test_threads_to_import_comments_empty() {
    let comments = threads_to_import_comments(&[]);
    assert!(comments.is_empty());
}

#[test]
fn test_threads_to_import_comments_skips_empty_messages() {
    let thread = Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![],
    };
    let comments = threads_to_import_comments(&[thread]);
    assert!(comments.is_empty());
}

// ---------------------------------------------------------------------------
// ReviewState JSON シリアライズ
// ---------------------------------------------------------------------------

#[test]
fn test_review_state_roundtrip() {
    let state = ReviewState {
        port: 8080,
        pid: 12345,
        comments: vec![serde_json::json!({"type": "thread", "body": "test"})],
        difit_args: vec!["working".to_string()],
    };
    let json = serde_json::to_string(&state).unwrap();
    let parsed: ReviewState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.port, 8080);
    assert_eq!(parsed.pid, 12345);
    assert_eq!(parsed.comments.len(), 1);
    assert_eq!(parsed.difit_args, vec!["working"]);
}

// ---------------------------------------------------------------------------
// .difit/ ディレクトリ & 状態ファイル
// ---------------------------------------------------------------------------

#[test]
fn test_ensure_difit_dir_idempotent() {
    let (_tmp, path) = make_temp_git_repo();
    ensure_difit_dir(&path).unwrap();
    assert!(difit_dir(&path).exists());
    // 2 回呼んでもエラーにならない
    ensure_difit_dir(&path).unwrap();
    assert!(difit_dir(&path).exists());
}

#[test]
fn test_review_state_write_read_delete() {
    let (_tmp, path) = make_temp_git_repo();
    let state = ReviewState {
        port: 9999,
        pid: 11111,
        comments: vec![],
        difit_args: vec!["HEAD".to_string()],
    };

    assert!(read_review_state(&path).is_none());

    write_review_state(&path, &state).unwrap();
    let loaded = read_review_state(&path).expect("state should exist");
    assert_eq!(loaded.port, 9999);
    assert_eq!(loaded.pid, 11111);

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

#[cfg(unix)]
#[test]
fn test_spawn_kills_child_on_startup_output_errors() {
    let _guard = DIFIT_TEST_LOCK.lock().unwrap();
    let (_repo_tmp, repo) = make_temp_git_repo();
    let fake_bin_dir = tempfile::tempdir().unwrap();
    let fake_difit = fake_bin_dir.path().join("difit");
    let pid_file = fake_bin_dir.path().join("child.pid");
    let original_path = std::env::var_os("PATH");
    let fake_path = match original_path.as_ref() {
        Some(path) => format!(
            "{}:{}",
            fake_bin_dir.path().display(),
            path.to_string_lossy()
        ),
        None => fake_bin_dir.path().display().to_string(),
    };

    unsafe {
        std::env::set_var("PATH", &fake_path);
        std::env::set_var("DIFIT_PID_FILE", &pid_file);
    }

    for output in [
        // 10 行読んでも JSON がない経路。子プロセスはその後も生存させる。
        "printf '%s\\n' \"$$\" > \"$DIFIT_PID_FILE\"\nfor i in 1 2 3 4 5 6 7 8 9 10; do printf 'not-json\\n'; done\nexec sleep 30\n",
        // JSON らしい行はあるが、パースに失敗する経路。
        "printf '%s\\n' \"$$\" > \"$DIFIT_PID_FILE\"\nprintf '{invalid-json}\\n'\nexec sleep 30\n",
    ] {
        std::fs::write(&fake_difit, format!("#!/bin/sh\n{output}")).unwrap();
        let mut permissions = std::fs::metadata(&fake_difit).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_difit, permissions).unwrap();
        let _ = std::fs::remove_file(&pid_file);

        let result = spawn_difit_server(&repo, &[], &[]);
        assert!(result.is_err(), "不正な起動出力はエラーになること");
        let child_pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(
            !is_process_alive(child_pid),
            "起動後エラー時は子プロセスを停止すること"
        );
    }

    unsafe {
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
        std::env::remove_var("DIFIT_PID_FILE");
    }
}
