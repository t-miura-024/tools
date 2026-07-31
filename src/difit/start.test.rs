//! `mt difit start` のテスト。
//!
//! 実 difit バイナリを使った統合テストを含む（完了条件 6）。
//! difit サーバのポート競合を避けるため、統合テストは Mutex で直列化する。

use super::*;
use std::process::Command;

// ---------------------------------------------------------------------------
// 統合テスト: 実 difit サーバ起動（完了条件 1, 3）
// ---------------------------------------------------------------------------

#[test]
fn test_start_spawns_server_and_writes_state() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    // 差分を作る
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[context] test comment"
    });

    let bg = shared::spawn_difit_server(&path, &["working".to_string()], &[comment.clone()])
        .expect("difit サーバ起動");

    assert!(bg.port > 0);
    assert!(bg.pid > 0);
    assert!(shared::is_process_alive(bg.pid));

    // .difit/ ディレクトリと状態ファイルの作成
    shared::ensure_difit_dir(&path).unwrap();
    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: vec![comment],
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(&path, &state).unwrap();

    assert!(shared::difit_dir(&path).exists());
    let loaded = shared::read_review_state(&path).expect("state が読み込める");
    assert_eq!(loaded.port, bg.port);
    assert_eq!(loaded.pid, bg.pid);

    // コメントが取得できる
    let resp = shared::fetch_comments(bg.port).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(resp.threads[0].messages[0].body, "[context] test comment");

    // クリーンアップ
    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));
}

// ---------------------------------------------------------------------------
// 統合テスト: 再注入 & resolve 済み除外（方針 6, 完了条件 4）
// ---------------------------------------------------------------------------

#[test]
fn test_reinject_excludes_resolved_threads() {
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
            "body": "[issue] problem 1"
        }),
        serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[context] info"
        }),
    ];

    // 初回起動
    let bg1 = shared::spawn_difit_server(&path, &["working".to_string()], &comments)
        .expect("初回起動");

    // 1 つ目のスレッドを resolve
    let resp = shared::fetch_comments(bg1.port).unwrap();
    assert_eq!(resp.threads.len(), 2);
    let thread_id = &resp.threads[0].id;

    let resolve_output = Command::new("difit")
        .args(["comment", "resolve", "--port", &bg1.port.to_string(), thread_id])
        .output()
        .expect("resolve");
    assert!(resolve_output.status.success());

    // resolve 後に comment get → 1 スレッドのみ
    let resp_after = shared::fetch_comments(bg1.port).unwrap();
    assert_eq!(resp_after.threads.len(), 1);

    // 変換して再注入用コメントを生成
    let reimport = shared::threads_to_import_comments(&resp_after.threads);
    assert_eq!(reimport.len(), 1);
    assert_eq!(reimport[0]["body"], "[context] info");

    // kill → 再注入で再起動
    shared::kill_server(bg1.pid);

    let bg2 = shared::spawn_difit_server(&path, &["working".to_string()], &reimport)
        .expect("再注入起動");

    let resp2 = shared::fetch_comments(bg2.port).unwrap();
    assert_eq!(resp2.threads.len(), 1, "resolve 済みは再注入されない");
    assert_eq!(resp2.threads[0].messages[0].body, "[context] info");

    shared::kill_server(bg2.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: stale 自己修復（完了条件 5）
// ---------------------------------------------------------------------------

#[test]
fn test_stale_state_recovery() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] stale test"
    });

    // サーバ起動 → 即 kill で stale 状態を再現
    let bg = shared::spawn_difit_server(&path, &["working".to_string()], &[comment.clone()])
        .expect("起動");
    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));

    // stale 状態を保存
    shared::ensure_difit_dir(&path).unwrap();
    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: vec![comment],
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(&path, &state).unwrap();

    // 復旧: 保存済みコメントで再起動
    let loaded = shared::read_review_state(&path).unwrap();
    assert!(!shared::is_process_alive(loaded.pid), "stale 確認");

    let bg2 = shared::spawn_difit_server(&path, &loaded.difit_args, &loaded.comments)
        .expect("stale 復旧起動");
    assert!(shared::is_process_alive(bg2.pid));

    let resp = shared::fetch_comments(bg2.port).unwrap();
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(resp.threads[0].messages[0].body, "[issue] stale test");

    shared::kill_server(bg2.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: reply 付き再注入ラウンドトリップ（should #2, 完了条件 4）
// ---------------------------------------------------------------------------

#[test]
fn test_reinject_reply_roundtrip() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // 1. thread 付きでサーバ起動
    let thread_comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] parent thread"
    });
    let bg1 = shared::spawn_difit_server(&path, &["working".to_string()], &[thread_comment])
        .expect("初回起動");

    // 2. reply を追加
    let resp1 = shared::fetch_comments(bg1.port).unwrap();
    assert_eq!(resp1.threads.len(), 1);
    let thread_id = &resp1.threads[0].id;

    let reply_json = serde_json::json!({
        "type": "reply",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "this is a reply"
    });
    let add_output = Command::new("difit")
        .args(["comment", "add", "--port", &bg1.port.to_string()])
        .arg(reply_json.to_string())
        .output()
        .expect("reply 追加");
    assert!(add_output.status.success(), "reply 追加が成功すること");

    // reply が付いたことを確認
    let resp_with_reply = shared::fetch_comments(bg1.port).unwrap();
    assert_eq!(resp_with_reply.threads.len(), 1);
    assert_eq!(resp_with_reply.threads[0].messages.len(), 2, "thread + reply の 2 メッセージ");
    assert_eq!(resp_with_reply.threads[0].messages[0].body, "[issue] parent thread");
    assert_eq!(resp_with_reply.threads[0].messages[1].body, "this is a reply");

    // 3. 変換（threads_to_import_comments）
    let reimport = shared::threads_to_import_comments(&resp_with_reply.threads);
    assert_eq!(reimport.len(), 2, "thread 1 + reply 1 = 2 エントリ");
    assert_eq!(reimport[0]["type"], "thread");
    assert_eq!(reimport[0]["id"], thread_id.as_str());
    assert_eq!(reimport[1]["type"], "reply");
    assert!(reimport[1].get("parentId").is_none(), "parentId はスキーマ外");

    // 4. kill（クラッシュ模擬）→ 再注入で再起動
    shared::kill_server(bg1.pid);
    assert!(!shared::is_process_alive(bg1.pid));

    let bg2 = shared::spawn_difit_server(&path, &["working".to_string()], &reimport)
        .expect("再注入起動");

    // 5. reply が親スレッドに再付着していることを検証
    let resp2 = shared::fetch_comments(bg2.port).unwrap();
    assert_eq!(resp2.threads.len(), 1, "スレッドは 1 つ");
    assert_eq!(resp2.threads[0].messages.len(), 2, "reply が再付着している");
    assert_eq!(resp2.threads[0].messages[0].body, "[issue] parent thread");
    assert_eq!(resp2.threads[0].messages[1].body, "this is a reply");
    // スレッド ID が維持されている（方針 5）
    assert_eq!(resp2.threads[0].id, *thread_id, "スレッド ID が維持される");

    shared::kill_server(bg2.pid);
}
