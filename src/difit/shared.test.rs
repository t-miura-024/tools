use super::*;
use crate::difit::gate::Message;
use crate::test_support::{difit_test_lock, make_temp_git_repo, require_difit, run_mt_with_env};

// ---------------------------------------------------------------------------
// threads_to_import_comments
// ---------------------------------------------------------------------------

fn make_message(id: &str, author: Option<&str>, body: &str) -> Message {
    Message {
        id: id.to_string(),
        author: author.map(str::to_string),
        body: body.to_string(),
    }
}

fn make_thread(body: &str) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![make_message("m1", None, body)],
    }
}

fn make_thread_with_authors(
    parent_author: Option<&str>,
    parent_body: &str,
    reply_author: Option<&str>,
    reply_body: &str,
) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![
            make_message("m1", parent_author, parent_body),
            make_message("m2", reply_author, reply_body),
        ],
    }
}

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
    let threads = vec![make_thread_with_authors(
        None,
        "[issue] bug",
        None,
        "will fix",
    )];
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
    assert!(
        comments[1].get("parentId").is_none(),
        "parentId はスキーマ外のため出力しない"
    );
}

#[test]
fn test_threads_to_import_comments_preserves_id() {
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

#[test]
fn test_threads_to_import_comments_carries_author() {
    let thread =
        make_thread_with_authors(Some("User"), "human parent", Some("User"), "human reply");
    let comments = threads_to_import_comments(&[thread]);

    assert_eq!(
        comments[0]["author"], "User",
        "thread 親の author を保持する"
    );
    assert_eq!(
        comments[1]["author"], "User",
        "reply の author を保持する（復旧の再注入で人間 reply を失わない）"
    );
}

#[test]
fn test_threads_to_import_comments_omits_absent_author() {
    // author 未設定時はフィールド自体を出力しない（null は difit import が拒否する）
    let threads = vec![make_thread("[issue] ai comment")];
    let comments = threads_to_import_comments(&threads);
    assert!(
        comments[0].get("author").is_none(),
        "author なしはフィールドを省略する"
    );
}

// ---------------------------------------------------------------------------
// synthesize_missing_positions（ADR-0011）
// ---------------------------------------------------------------------------

#[test]
fn test_synthesize_missing_positions_adds_line_1_for_file_level_comment() {
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "body": "[issue] file-level comment"
    })];

    let result = synthesize_missing_positions(comments);

    assert_eq!(result.len(), 1);
    assert_eq!(
        result[0]["position"],
        serde_json::json!({"side": "new", "line": 1})
    );
    // 他のフィールドは保持される
    assert_eq!(result[0]["type"], "thread");
    assert_eq!(result[0]["filePath"], "README.md");
    assert_eq!(result[0]["body"], "[issue] file-level comment");
}

#[test]
fn test_synthesize_missing_positions_preserves_existing_position() {
    let comments = vec![
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 42},
            "body": "[issue] thread"
        }),
        serde_json::json!({
            "type": "reply",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "reply"
        }),
    ];

    let result = synthesize_missing_positions(comments);

    assert_eq!(
        result[0]["position"],
        serde_json::json!({"side": "new", "line": 42})
    );
    assert_eq!(
        result[1]["position"],
        serde_json::json!({"side": "new", "line": 2})
    );
    // 余計なフィールドが追加されない（キー数が変わらない）
    assert_eq!(result[0].as_object().unwrap().len(), 4);
    assert_eq!(result[1].as_object().unwrap().len(), 4);
}

#[test]
fn test_synthesize_missing_positions_only_for_missing_and_idempotent() {
    let comments = vec![
        serde_json::json!({
            "type": "thread",
            "filePath": "a.rs",
            "position": {"side": "new", "line": 7},
            "body": "[context] anchored"
        }),
        serde_json::json!({
            "type": "thread",
            "filePath": "b.rs",
            "body": "[issue] file-level"
        }),
    ];

    let once = synthesize_missing_positions(comments);
    assert_eq!(
        once[0]["position"],
        serde_json::json!({"side": "new", "line": 7})
    );
    assert_eq!(
        once[1]["position"],
        serde_json::json!({"side": "new", "line": 1})
    );

    let twice = synthesize_missing_positions(once.clone());
    assert_eq!(twice, once, "再適用しても結果が変わらないこと");
}

#[test]
fn test_synthesize_missing_positions_leaves_non_object_entries() {
    let comments = vec![serde_json::json!("not an object")];
    let result = synthesize_missing_positions(comments);
    assert_eq!(result, vec![serde_json::json!("not an object")]);
}

#[test]
fn test_synthesize_missing_positions_empty() {
    let result = synthesize_missing_positions(vec![]);
    assert!(result.is_empty());
}

// ---------------------------------------------------------------------------
// ReviewState JSON シリアライズ
// ---------------------------------------------------------------------------

fn sample_selection() -> CommentSelection {
    CommentSelection {
        base: "staged".to_string(),
        target: "working".to_string(),
        base_mode: None,
    }
}

#[test]
fn test_review_state_roundtrip() {
    let state = ReviewState {
        port: 8080,
        pid: 12345,
        comments: vec![serde_json::json!({"type": "thread", "body": "test"})],
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };
    let json = serde_json::to_string(&state).unwrap();
    let parsed: ReviewState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.port, 8080);
    assert_eq!(parsed.pid, 12345);
    assert_eq!(parsed.comments.len(), 1);
    assert_eq!(parsed.difit_args, vec!["working"]);
    assert_eq!(parsed.selection, Some(sample_selection()));
}

#[test]
fn test_review_state_reads_legacy_json_without_selection() {
    // selection なしの旧 difit JSON も読める（デフォルト None）。
    // selection なしは check が fail-closed で停止する。
    let json = r#"{"port":1,"pid":2,"comments":[],"difit_args":["working"]}"#;
    let parsed: ReviewState = serde_json::from_str(json).unwrap();
    assert!(parsed.selection.is_none());
}

#[test]
fn test_review_state_ignores_legacy_tab_field() {
    // タブ表示を撤去する前の state（tab フィールド付き）も読み飛ばせる。
    let (_tmp, path) = make_temp_git_repo();
    ensure_difit_dir(&path).unwrap();
    std::fs::write(
        review_state_path(&path),
        r#"{"port":4966,"pid":123,"comments":[],"difit_args":["working"],"tab":{"tab_id":"w1:t2","pane_id":"w1:p2"}}"#,
    )
    .unwrap();

    let parsed = read_review_state(&path).expect("tab フィールド付きの旧 state も読める");
    assert_eq!(parsed.port, 4966);
    assert!(parsed.selection.is_none());
}

#[test]
fn test_read_review_state_rejects_nonpositive_pid_and_zero_port() {
    let (_tmp, path) = make_temp_git_repo();
    ensure_difit_dir(&path).unwrap();
    let state_path = review_state_path(&path);

    for json in [
        r#"{"port":1,"pid":0,"comments":[],"difit_args":[]}"#,
        r#"{"port":1,"pid":-1,"comments":[],"difit_args":[]}"#,
        r#"{"port":0,"pid":123,"comments":[],"difit_args":[]}"#,
    ] {
        std::fs::write(&state_path, json).unwrap();
        assert!(
            read_review_state(&path).is_none(),
            "不正な state は stale として無視する（kill 経路へ渡さない）: {json}"
        );
    }

    std::fs::write(
        &state_path,
        r#"{"port":1,"pid":123,"comments":[],"difit_args":[]}"#,
    )
    .unwrap();
    assert!(
        read_review_state(&path).is_some(),
        "正常な state は読み込める"
    );
}

#[test]
fn test_is_process_alive_rejects_nonpositive_pid() {
    // kill(0) / kill(-1) は成功するため、素通しすると生存扱いになる
    assert!(!is_process_alive(0));
    assert!(!is_process_alive(-1));
}

#[test]
fn test_kill_server_rejects_nonpositive_pid() {
    // ガードが壊れているとテストランナーごと kill しかねないため、
    // kill を呼ぶ前に生存判定の拒否を確認する。
    assert!(
        !is_process_alive(0) && !is_process_alive(-1),
        "前提: pid<=0 は生存扱いしない"
    );
    kill_server(0);
    kill_server(-1);
    // ここに到達すること自体が kill(0) / kill(-1) を実行していない証拠
}

/// 自プロセスで TCP リスナーを開き、その port に対して pid の一致を判定できるか。
#[test]
fn test_is_pid_listening_on_port_matches_own_listener() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener の bind");
    let port = listener.local_addr().expect("local_addr").port();
    let own_pid = std::process::id() as i32;

    assert!(
        is_pid_listening_on_port(own_pid, port),
        "LISTEN 中の自 pid は一致する (pid={own_pid}, port={port})"
    );
    assert!(
        !is_pid_listening_on_port(own_pid.wrapping_add(1), port),
        "LISTEN していない pid は一致しない"
    );
    assert!(!is_pid_listening_on_port(0, port), "pid<=0 は照合しない");
    assert!(!is_pid_listening_on_port(own_pid, 0), "port 0 は照合しない");
}

/// 記録 pid が記録 port の LISTEN でない state は、照合不能としてエラーになる。
#[test]
fn test_require_server_identity_rejects_unverified_state() {
    let state = ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: vec![],
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };
    let error = require_server_identity(&state).expect_err("照合不能はエラー");
    assert!(error.to_string().contains("同一性"), "{error:#}");
    assert!(error.to_string().contains("mt difit start"), "{error:#}");
}

/// `/api/diff` だけを応答する簡易 HTTP スタブ（テスト用バインド 127.0.0.1）。
fn spawn_difit_stub(diff_body: Option<&'static str>) -> u16 {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("stub の bind");
    let port = listener.local_addr().expect("local_addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                break;
            };
            let mut buffer = [0u8; 2048];
            let Ok(read) = stream.read(&mut buffer) else {
                continue;
            };
            let request = String::from_utf8_lossy(&buffer[..read]);
            let path = request.split_whitespace().nth(1).unwrap_or("");
            let response = match diff_body {
                Some(body) if path.starts_with("/api/diff") => format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                ),
                _ => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
            };
            let _ = stream.write_all(response.as_bytes());
        }
    });
    port
}

/// 生存判定は `/api/diff` の軽量プローブで行い、コメント全件の取得に依存しない。
#[test]
fn test_is_server_live_probes_diff_api_without_fetching_comments() {
    let stub_state = |port: u16| ReviewState {
        port,
        pid: std::process::id() as i32,
        comments: vec![],
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };

    // /api/diff が応答すれば生存扱い（コメント API は呼ばれない）
    let port = spawn_difit_stub(Some(
        r#"{"baseCommitish":"abc1234","targetCommitish":"working"}"#,
    ));
    assert!(
        is_server_live(&stub_state(port)),
        "/api/diff 応答で生存と判定する"
    );

    // /api/diff が応答しない（500）場合は生存扱いしない
    let port = spawn_difit_stub(None);
    assert!(
        !is_server_live(&stub_state(port)),
        "/api/diff 不応答は生存扱いしない"
    );
}
/// kill 前に pid と port の対応を OS 情報で照合し、照合成功時のみ停止する。
#[test]
fn test_kill_verified_server_requires_pid_to_listen_on_port() {
    let _guard = difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, repo) = make_temp_git_repo();
    std::fs::write(repo.join("README.md"), "hello\nworld\n").unwrap();
    let server =
        start_difit_server(&repo, &["working".to_string()], &[]).expect("difit サーバ起動");
    assert!(
        is_pid_listening_on_port(server.pid, server.port),
        "起動直後の difit は記録 port を LISTEN している"
    );

    // 記録 port に応答するサーバとは別の生存 pid は kill しない。
    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    kill_verified_server(victim_pid, server.port);
    assert!(is_process_alive(victim_pid), "無関係プロセスを kill しない");
    assert!(
        is_process_alive(server.pid),
        "記録 port のサーバも kill しない"
    );

    // 記録 port を LISTEN している pid は kill する。
    kill_verified_server(server.pid, server.port);
    assert!(!is_process_alive(server.pid), "同一性一致時は停止する");

    let _ = victim.kill();
    let _ = victim.wait();
}

/// 記録 pid が記録 port を LISTEN しているのに difit として応答しない場合、
/// ensure_server_running は旧サーバを kill せず専用の孤児警告を出し、新サーバで復旧する。
#[cfg(unix)]
#[test]
fn test_ensure_server_running_warns_orphan_when_listening_but_unresponsive() {
    let _guard = difit_test_lock();
    if !require_difit() {
        return;
    }
    let Some(listener) = crate::test_support::UnresponsiveListener::spawn() else {
        eprintln!("SKIP: nc が利用できません");
        return;
    };

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let state = ReviewState {
        port: listener.port,
        pid: listener.pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };
    write_review_state(&path, &state).unwrap();

    // mt difit check の stale 復旧経路（ensure_server_running）を通す。probe は 500 で
    // 失敗するが LISTEN の照合は成立するため、旧サーバは孤児として残る。
    let output = run_mt_with_env(&path, &["difit", "check"], "", &[]);
    assert!(
        output.status.success(),
        "復旧後の check が通過すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("LISTEN していますが") && stderr.contains("difit として応答しない"),
        "応答しない旧サーバの専用警告が出る: {stderr}"
    );
    assert!(
        stderr.contains(&format!("kill {}", listener.pid)),
        "人間が手動停止できるよう pid つきの停止コマンドを案内する: {stderr}"
    );
    assert!(
        listener.is_alive(),
        "未回収コメントを失わないため、応答しない旧サーバを kill しない"
    );

    // 通過時の後始末で復旧後のサーバ・状態は片付く（旧サーバは孤児のまま残る）
    assert!(
        read_review_state(&path).is_none(),
        "check 通過で状態が削除される"
    );
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
        selection: Some(sample_selection()),
    };

    assert!(read_review_state(&path).is_none());

    write_review_state(&path, &state).unwrap();
    let loaded = read_review_state(&path).expect("state should exist");
    assert_eq!(loaded.port, 9999);
    assert_eq!(loaded.pid, 11111);
    assert_eq!(loaded.selection, Some(sample_selection()));

    delete_review_state(&path);
    assert!(read_review_state(&path).is_none());
}

#[test]
fn test_write_review_state_does_not_leave_partial_file() {
    // 一時ファイル経由の書き込みでも、状態ファイルは常に完全な JSON になる
    let (_tmp, path) = make_temp_git_repo();
    let state = ReviewState {
        port: 9999,
        pid: 11111,
        comments: vec![],
        difit_args: vec!["working".to_string()],
        selection: None,
    };
    write_review_state(&path, &state).unwrap();

    let raw = std::fs::read_to_string(review_state_path(&path)).unwrap();
    let parsed: ReviewState = serde_json::from_str(&raw).expect("完全な JSON として読める");
    assert_eq!(parsed.port, 9999);

    let leftovers: Vec<String> = std::fs::read_dir(difit_dir(&path))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "一時ファイルは残さない: {leftovers:?}"
    );
}

/// clone 先に仕込まれた一時ファイル symlink を追従せず、リンク先を破壊しない。
#[cfg(unix)]
#[test]
fn test_write_review_state_does_not_follow_planted_tmp_symlink() {
    use std::os::unix::fs::symlink;

    let (_tmp, path) = make_temp_git_repo();
    let dir = difit_dir(&path);
    std::fs::create_dir_all(&dir).unwrap();

    // 攻撃: 固定名の一時ファイル（difit-review.json.tmp）を symlink として
    // 仕込み、state 更新のたびにリンク先を truncate 上書きさせる。
    let victim = path.join("victim.txt");
    std::fs::write(&victim, "do not touch\n").unwrap();
    let planted = review_state_path(&path).with_extension("json.tmp");
    symlink(&victim, &planted).unwrap();

    let state = ReviewState {
        port: 9999,
        pid: 11111,
        comments: vec![],
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };
    write_review_state(&path, &state).expect("symlink を無視して書き込める");

    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "do not touch\n",
        "symlink のリンク先を書き換えない"
    );
    assert!(
        std::fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink(),
        "仕込まれた symlink 自体も触らない"
    );
    assert!(read_review_state(&path).is_some(), "state は更新される");
}

/// `.difit/.gitignore` の symlink（dangling 含む）を拒否し、リンク先を作らない。
#[cfg(unix)]
#[test]
fn test_ensure_difit_dir_rejects_gitignore_symlink() {
    use std::os::unix::fs::symlink;

    let (_tmp, path) = make_temp_git_repo();
    let dir = difit_dir(&path);
    std::fs::create_dir_all(&dir).unwrap();

    // dangling symlink は exists() が false になるため、存在確認だけの旧実装は
    // fs::write でリンク先の任意パスを新規作成してしまう。
    let victim = path.join("victim.txt");
    let planted = dir.join(".gitignore");
    symlink(&victim, &planted).unwrap();

    let error = ensure_difit_dir(&path).expect_err("symlink は拒否する");
    assert!(error.to_string().contains("symlink"), "{error:#}");
    assert!(!victim.exists(), "リンク先を新規作成しない");
    assert!(
        std::fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink(),
        "仕込まれた symlink 自体も触らない"
    );
}

/// `.difit` ディレクトリ自体の symlink（dangling 含む）を状態 IO が拒否し、
/// リンク先に触れない。
#[cfg(unix)]
#[test]
fn test_difit_dir_symlink_is_rejected_by_state_io() {
    use std::os::unix::fs::symlink;

    // 既存ディレクトリへの symlink（並列 worktree の .difit や $HOME を狙う形）
    let (_tmp, path) = make_temp_git_repo();
    let target = tempfile::tempdir().expect("リンク先ディレクトリ");
    symlink(target.path(), difit_dir(&path)).unwrap();

    let error = ensure_difit_dir(&path).expect_err("symlink の .difit は拒否する");
    assert!(error.to_string().contains("symlink"), "{error:#}");
    assert!(read_review_state(&path).is_none(), "read も追従しない");
    delete_review_state(&path);
    assert!(
        std::fs::read_dir(target.path()).unwrap().next().is_none(),
        "リンク先に何も作らない・消さない"
    );
    assert!(
        std::fs::symlink_metadata(difit_dir(&path))
            .unwrap()
            .file_type()
            .is_symlink(),
        "symlink 自体は残す"
    );

    // dangling symlink（exists() が false になる形）も拒否する
    let (_tmp2, path2) = make_temp_git_repo();
    symlink(path2.join("missing-target"), difit_dir(&path2)).unwrap();
    let error = ensure_difit_dir(&path2).expect_err("dangling symlink も拒否する");
    assert!(error.to_string().contains("symlink"), "{error:#}");
}

/// `difit-review.json` 自体の symlink は state として読まない（リンク先を
/// パースしない）。
#[cfg(unix)]
#[test]
fn test_read_review_state_does_not_follow_state_symlink() {
    use std::os::unix::fs::symlink;

    let (_tmp, path) = make_temp_git_repo();
    ensure_difit_dir(&path).unwrap();

    let victim = path.join("victim.json");
    std::fs::write(
        &victim,
        r#"{"port":1,"pid":2,"comments":[],"difit_args":[]}"#,
    )
    .unwrap();
    symlink(&victim, review_state_path(&path)).unwrap();

    assert!(
        read_review_state(&path).is_none(),
        "symlink の state は追従しない"
    );
}

/// `.difit` ディレクトリ自体が symlink の場合、start / check / done / threads は
/// リンク先のファイルを一切変更しない（fail-closed）。
///
/// ルート `.gitignore` の `.difit/` は末尾スラッシュのため `.difit` symlink は
/// 無視対象外で commit でき、`exists()` はリンク先へ追従する。検査がないと、
/// リンク先ディレクトリで `.gitignore` 生成・state 書き込み・state 削除が
/// 実行される（別 worktree の state 上書き・リポジトリ外への書き込み）。
#[cfg(unix)]
#[test]
fn test_difit_dir_symlink_cli_is_fail_closed_and_target_unchanged() {
    use std::os::unix::fs::symlink;

    let (_tmp, path) = make_temp_git_repo();
    let target = tempfile::tempdir().expect("リンク先ディレクトリ");
    let victim_state = target.path().join("difit-review.json");
    let victim_gitignore = target.path().join(".gitignore");
    let victim_tmp = target.path().join("difit-review.json.deadbeef.tmp");
    let state_json = r#"{"port":1,"pid":2,"comments":[],"difit_args":["working"],"selection":{"base":"staged","target":"working"}}"#;
    std::fs::write(&victim_state, state_json).unwrap();
    std::fs::write(&victim_gitignore, "keep\n").unwrap();
    std::fs::write(&victim_tmp, "keep\n").unwrap();
    symlink(target.path(), difit_dir(&path)).unwrap();

    // start: symlink を検知して拒否する（difit サーバは起動しない）
    let output = run_mt_with_env(&path, &["difit", "start", "working"], "", &[]);
    assert!(
        !output.status.success(),
        "start は symlink の .difit を拒否する: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("symlink"),
        "原因が分かるエラーを出す: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // check / --dry-run / threads: セッションなしとして fail-closed（JSON を出さない）
    let arg_sets: [&[&str]; 3] = [
        &["difit", "check"],
        &["difit", "check", "--dry-run"],
        &["difit", "threads", "--json"],
    ];
    for args in arg_sets {
        let output = run_mt_with_env(&path, args, "", &[]);
        assert!(
            !output.status.success(),
            "{args:?} は非 0 exit: stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stdout.is_empty(),
            "{args:?} は pass と解釈できる JSON を出さない: {}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    // done: 終了コマンドとして exit 0 を維持する（リンク先には触れない）
    let output = run_mt_with_env(&path, &["difit", "done"], "", &[]);
    assert!(
        output.status.success(),
        "done は終了コマンドとして exit 0: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // リンク先は一切変更されない
    assert_eq!(
        std::fs::read_to_string(&victim_state).unwrap(),
        state_json,
        "リンク先の state を上書き・削除しない"
    );
    assert_eq!(
        std::fs::read_to_string(&victim_gitignore).unwrap(),
        "keep\n",
        "リンク先に .gitignore を作らない"
    );
    assert_eq!(
        std::fs::read_to_string(&victim_tmp).unwrap(),
        "keep\n",
        "リンク先の一時ファイルを削除しない"
    );
    assert!(
        std::fs::symlink_metadata(difit_dir(&path))
            .unwrap()
            .file_type()
            .is_symlink(),
        "仕込まれた symlink 自体も残す"
    );
}

#[test]
fn test_url_for_port() {
    assert_eq!(url_for_port(4966), "http://localhost:4966");
}

#[test]
fn test_close_session_deletes_state_idempotently() {
    let (_tmp, path) = make_temp_git_repo();
    let state = ReviewState {
        port: 9999,
        pid: 2_000_000_000,
        comments: vec![],
        difit_args: vec!["working".to_string()],
        selection: Some(sample_selection()),
    };
    write_review_state(&path, &state).unwrap();

    // 同一性未確認（None）でも状態削除は行う
    close_session(&path, None);
    assert!(read_review_state(&path).is_none());

    // 2 回目もエラーにならない（冪等）
    close_session(&path, None);
    assert!(!review_state_path(&path).exists());
}

#[test]
fn test_git_repo_root_in() {
    let (_tmp, path) = make_temp_git_repo();
    let sub = path.join("subdir");
    std::fs::create_dir_all(&sub).unwrap();
    let root = git_repo_root_in(&sub).unwrap();
    assert_eq!(root, path.canonicalize().unwrap());
}

// ---------------------------------------------------------------------------
// 起動失敗時の子プロセス停止（実 mt バイナリ + fake difit）
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn test_start_kills_child_on_startup_output_errors() {
    use std::os::unix::fs::PermissionsExt;

    let (_repo_tmp, repo) = make_temp_git_repo();
    let fake_bin_dir = tempfile::tempdir().unwrap();
    let fake_difit = fake_bin_dir.path().join("difit");
    let pid_file = fake_bin_dir.path().join("child.pid");
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let fake_path = format!(
        "{}:{}",
        fake_bin_dir.path().display(),
        original_path.to_string_lossy()
    );

    for output in [
        // 10 行読んでも JSON がない経路。子プロセスはその後も生存させる。
        "printf '%s\\n' \"$$\" > \"$DIFIT_PID_FILE\"\nfor i in 1 2 3 4 5 6 7 8 9 10; do printf 'not-json\\n'; done\nexec sleep 30\n",
        // JSON らしい行はあるが、パースに失敗する経路。
        "printf '%s\\n' \"$$\" > \"$DIFIT_PID_FILE\"\nprintf '{invalid-json}\\n'\nexec sleep 30\n",
    ] {
        std::fs::write(&fake_difit, format!("#!/bin/sh\n{output}")).unwrap();
        let mut permissions = std::fs::metadata(&fake_difit).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_difit, permissions).unwrap();
        let _ = std::fs::remove_file(&pid_file);

        let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
        crate::git::common::clear_git_context(&mut command);
        let result = command
            .args(["difit", "start", "working"])
            .current_dir(&repo)
            .env("PATH", &fake_path)
            .env("DIFIT_PID_FILE", &pid_file)
            .output()
            .expect("mt difit start の実行");

        assert!(
            !result.status.success(),
            "不正な起動出力はエラーになること: {}",
            String::from_utf8_lossy(&result.stdout)
        );
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
}

#[cfg(unix)]
#[test]
fn test_start_times_out_when_child_produces_no_output() {
    use std::os::unix::fs::PermissionsExt;

    let (_repo_tmp, repo) = make_temp_git_repo();
    let fake_bin_dir = tempfile::tempdir().unwrap();
    let fake_difit = fake_bin_dir.path().join("difit");
    let pid_file = fake_bin_dir.path().join("child.pid");
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let fake_path = format!(
        "{}:{}",
        fake_bin_dir.path().display(),
        original_path.to_string_lossy()
    );

    // 無出力のまま生存し続ける fake difit（起動ハングの再現）。
    std::fs::write(
        &fake_difit,
        "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$DIFIT_PID_FILE\"\nexec sleep 30\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&fake_difit).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_difit, permissions).unwrap();

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let result = command
        .args(["difit", "start", "working"])
        .current_dir(&repo)
        .env("PATH", &fake_path)
        .env("DIFIT_PID_FILE", &pid_file)
        // テストを速くするため読み取り期限を 1 秒に短縮する
        .env("MT_DIFIT_STARTUP_TIMEOUT_SECS", "1")
        .output()
        .expect("mt difit start の実行");

    assert!(
        !result.status.success(),
        "無出力ハングは期限超過でエラーになること: {}",
        String::from_utf8_lossy(&result.stdout)
    );
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("タイムアウト"),
        "タイムアウトが原因だと分かること: {stderr}"
    );

    let child_pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        !is_process_alive(child_pid),
        "期限超過時は子プロセスを停止すること"
    );
}
