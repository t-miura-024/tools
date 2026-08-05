//! `mt difit start` のテスト。
//!
//! 実 difit バイナリを使った統合テストを含む（完了条件 6）。
//! difit サーバのポート競合を避けるため、統合テストは Mutex で直列化する。

use super::*;
use std::process::Command;

// ---------------------------------------------------------------------------
// ユニットテスト: 引数変換ロジック（ADR-0008, 完了条件 7）
// ---------------------------------------------------------------------------

/// ヘルパー: Vec<&str> → Vec<String>
fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn test_translate_single_branch_name() {
    // 単一ブランチ名 → "." を先頭に挿入 + --merge-base + --clean
    let result = translate_difit_args(args(&["main"]));
    assert_eq!(result, args(&[".", "main", "--merge-base", "--clean"]));
}

#[test]
fn test_translate_single_branch_name_develop() {
    let result = translate_difit_args(args(&["develop"]));
    assert_eq!(result, args(&[".", "develop", "--merge-base", "--clean"]));
}

#[test]
fn test_translate_dot_prefixed() {
    // 既に "." 付き → そのまま + フラグ追加（完了条件 4: "." を二重に付けない）
    let result = translate_difit_args(args(&[".", "main"]));
    assert_eq!(result, args(&[".", "main", "--merge-base", "--clean"]));
}

#[test]
fn test_translate_working() {
    // 特殊ターゲット → --merge-base 不要（完了条件 5）
    let result = translate_difit_args(args(&["working"]));
    assert_eq!(result, args(&["working", "--clean"]));
}

#[test]
fn test_translate_staged() {
    // 特殊ターゲット → --merge-base 不要（完了条件 5）
    let result = translate_difit_args(args(&["staged"]));
    assert_eq!(result, args(&["staged", "--clean"]));
}

#[test]
fn test_translate_empty() {
    // 空 → そのまま透過
    let result = translate_difit_args(vec![]);
    assert_eq!(result, Vec::<String>::new());
}

#[test]
fn test_translate_commit_ref_head_tilde() {
    // 単一コミット参照 → --merge-base 不要
    let result = translate_difit_args(args(&["HEAD~3"]));
    assert_eq!(result, args(&["HEAD~3", "--clean"]));
}

#[test]
fn test_translate_commit_ref_head_caret() {
    let result = translate_difit_args(args(&["HEAD^2"]));
    assert_eq!(result, args(&["HEAD^2", "--clean"]));
}

#[test]
fn test_translate_commit_ref_head_plain() {
    let result = translate_difit_args(args(&["HEAD"]));
    assert_eq!(result, args(&["HEAD", "--clean"]));
}

#[test]
fn test_translate_commit_ref_sha() {
    // SHA ハッシュ → コミット参照として扱う
    let result = translate_difit_args(args(&["abc1234"]));
    assert_eq!(result, args(&["abc1234", "--clean"]));
}

#[test]
fn test_translate_commit_ref_full_sha() {
    let result = translate_difit_args(args(&["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"]));
    assert_eq!(
        result,
        args(&["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "--clean"])
    );
}

#[test]
fn test_translate_branch_with_tilde_is_commit_ref() {
    // branch~N 形式もコミット参照として扱う
    let result = translate_difit_args(args(&["main~2"]));
    assert_eq!(result, args(&["main~2", "--clean"]));
}

#[test]
fn test_translate_multi_args_without_dot() {
    // 複数引数（"." なし）→ --clean のみ付与（保守的フォールバック）
    let result = translate_difit_args(args(&["main", "feature"]));
    assert_eq!(result, args(&["main", "feature", "--clean"]));
}

// ---------------------------------------------------------------------------
// ユニットテスト: position 合成（ADR-0011, 完了条件 1, 2）
// ---------------------------------------------------------------------------

#[test]
fn test_synthesize_missing_positions_adds_line_1_for_file_level_comment() {
    // 完了条件 1: position なし（ファイルレベル）エントリに {"side":"new","line":1} を合成
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "body": "[issue] file-level comment"
    })];

    let result = synthesize_missing_positions(comments);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["position"], serde_json::json!({"side": "new", "line": 1}));
    // 他のフィールドは保持される
    assert_eq!(result[0]["type"], "thread");
    assert_eq!(result[0]["filePath"], "README.md");
    assert_eq!(result[0]["body"], "[issue] file-level comment");
}

#[test]
fn test_synthesize_missing_positions_preserves_existing_position() {
    // 完了条件 2: position を持つエントリ（thread / reply）は一切変更しない
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

    assert_eq!(result[0]["position"], serde_json::json!({"side": "new", "line": 42}));
    assert_eq!(result[1]["position"], serde_json::json!({"side": "new", "line": 2}));
    // 余計なフィールドが追加されない（キー数が変わらない）
    assert_eq!(result[0].as_object().unwrap().len(), 4);
    assert_eq!(result[1].as_object().unwrap().len(), 4);
}

#[test]
fn test_synthesize_missing_positions_only_for_missing_and_idempotent() {
    // 完了条件 2: 欠落エントリのみ合成。再適用しても結果が変わらない（冪等）。
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
    assert_eq!(once[0]["position"], serde_json::json!({"side": "new", "line": 7}));
    assert_eq!(once[1]["position"], serde_json::json!({"side": "new", "line": 1}));

    let twice = synthesize_missing_positions(once.clone());
    assert_eq!(twice, once, "再適用しても結果が変わらないこと");
}

#[test]
fn test_synthesize_missing_positions_leaves_non_object_entries() {
    // 非オブジェクトエントリ（例: 文字列）は変更しない
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
// 統合テスト: untracked ファイルの intent-to-add マーク（ADR-0009）
// ---------------------------------------------------------------------------

#[test]
fn test_mark_untracked_intent_to_add_includes_files_in_diff() {
    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("new-file.txt"), "untracked content\n").unwrap();
    std::fs::write(path.join("ignored.txt"), "ignored content\n").unwrap();
    std::fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();

    mark_untracked_intent_to_add(&path);

    let output = Command::new("git")
        .args(["diff"])
        .current_dir(&path)
        .output()
        .expect("git diff");
    let diff = String::from_utf8_lossy(&output.stdout);
    assert!(diff.contains("new-file.txt"), "untracked ファイルが diff に含まれる");
    assert!(diff.contains("untracked content"), "untracked ファイルの内容が diff に含まれる");
    assert!(!diff.contains("diff --git a/ignored.txt"), "gitignore 対象はマークされない");
}

#[test]
fn test_mark_untracked_intent_to_add_no_untracked_files() {
    let (_tmp, path) = shared::make_temp_git_repo();
    // untracked なしでもエラーにならない
    mark_untracked_intent_to_add(&path);
}

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

// ---------------------------------------------------------------------------
// 統合テスト: 変換後引数による merge-base コメント配信エンドツーエンド
// （ADR-0008 回帰テスト, 完了条件 1, 2）
// ---------------------------------------------------------------------------

/// ヘルパー: 指定リポジトリで git コマンドを実行する（失敗時 panic）。
fn git_cmd(path: &std::path::Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .expect("git 実行");
    assert!(
        output.status.success(),
        "git {} が失敗しました: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

/// ヘルパー: difit サーバの HTTP エンドポイントを GET し、JSON として返す。
fn http_get_json(port: u16, path_and_query: &str) -> serde_json::Value {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let url = format!("http://localhost:{}{}", port, path_and_query);
    let resp = agent
        .get(&url)
        .call()
        .unwrap_or_else(|e| panic!("GET {} が失敗しました: {e}", url));
    resp.into_json().expect("JSON パース")
}

/// 変換後引数（`[".", "main", "--merge-base", "--clean"]`）で実 difit サーバを起動し、
/// 注入コメントが選択キー一致で配信されることをエンドツーエンドで検証する。
///
/// 修正前のバグ（`difit main` 実行 → 選択キー不一致 → `commentImports: null`）の回帰テスト。
#[test]
fn test_merge_base_args_delivers_comments_end_to_end() {
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    // 一時リポジトリ: main（ベースブランチ）→ 作業ブランチでコミット（乖離）→ ワーキングディレクトリ変更。
    // make_temp_git_repo は main ブランチ + README.md("hello\n") の初期コミットを作る。
    let (_tmp, path) = shared::make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    // ワーキングディレクトリ変更（未コミット）→ "." ターゲットの diff 対象
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();
    // untracked ファイル（ADR-0009）→ intent-to-add により diff 対象になる
    std::fs::write(path.join("new-file.txt"), "untracked content\n").unwrap();

    // 引数変換（ADR-0008）: ["main"] → [".", "main", "--merge-base", "--clean"]
    let difit_args = translate_difit_args(args(&["main"]));
    assert_eq!(difit_args, args(&[".", "main", "--merge-base", "--clean"]));

    // ADR-0009: mt difit start の untracked マークを再現（difit 起動前に実行）
    mark_untracked_intent_to_add(&path);

    // コメント位置はワーキングディレクトリ変更で追加した行（diff の new 側 3 行目）を指す
    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "[issue] merge-base delivery regression"
    });

    let bg = shared::spawn_difit_server(&path, &difit_args, &[comment])
        .expect("変換後引数での difit サーバ起動");
    assert!(shared::is_process_alive(bg.pid));

    // 1. /api/diff が commentImports を配信する（選択キー一致, 完了条件 2）。
    //    ブラウザ初回ロードと同じパラメータなしリクエスト。
    //    修正前のバグでは選択キー不一致により commentImports が欠落（null）していた。
    let diff = http_get_json(bg.port, "/api/diff");
    let imports = diff["commentImports"]
        .as_array()
        .expect("commentImports が配列として配信される");
    assert_eq!(imports.len(), 1, "注入コメントが配信される");
    assert_eq!(imports[0]["body"], "[issue] merge-base delivery regression");

    // diff セマンティクス: ワーキングディレクトリ vs ベースブランチの merge-base 解決（完了条件 1）
    assert_eq!(diff["requestedBaseCommitish"], "main");
    assert_eq!(diff["targetCommitish"], ".");
    assert_eq!(diff["requestedBaseMode"], "merge-base");
    assert_eq!(diff["clearComments"], true, "--clean がサーバに反映される");
    assert_eq!(diff["files"][0]["path"], "README.md");

    // ADR-0009: untracked ファイルが intent-to-add され diff に含まれる
    let file_paths: Vec<&str> = diff["files"]
        .as_array()
        .expect("files が配列")
        .iter()
        .map(|f| f["path"].as_str().expect("path"))
        .collect();
    assert!(
        file_paths.contains(&"new-file.txt"),
        "untracked ファイルが diff に含まれる: {file_paths:?}"
    );

    // 2. ブラウザのコメントブートストラップを再現: /api/diff レスポンスの解決済み選択キーで
    //    /api/comments-json を取得し、コメントが届くことを検証する。
    let base = diff["baseCommitish"].as_str().expect("baseCommitish");
    let target = diff["targetCommitish"].as_str().expect("targetCommitish");
    let comments = http_get_json(
        bg.port,
        &format!("/api/comments-json?base={base}&target={target}&baseMode=merge-base"),
    );
    let threads = comments["threads"].as_array().expect("threads");
    assert_eq!(threads.len(), 1, "解決済み選択キーでコメントが配信される");
    assert_eq!(
        threads[0]["messages"][0]["body"],
        "[issue] merge-base delivery regression"
    );

    // 3. fetch_comments（`mt difit check` が使う経路）でも取得できる
    let resp = shared::fetch_comments(bg.port).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(
        resp.threads[0].messages[0].body,
        "[issue] merge-base delivery regression"
    );

    // クリーンアップ
    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));
}

// ---------------------------------------------------------------------------
// 統合テスト: position なしコメントの起動（ADR-0011, 完了条件 1, 3）
// ---------------------------------------------------------------------------

/// 実 `mt` バイナリで `mt difit start working` を実行する（stdin は指定入力）。
fn run_mt_difit_start(path: &std::path::Path, stdin_input: &str) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(assert_cmd::cargo::cargo_bin("mt"))
        .args(["difit", "start", "working"])
        .current_dir(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mt difit start の実行");

    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin_input.as_bytes())
        .expect("stdin への書き込み");
    child.wait_with_output().expect("mt difit start の出力")
}

#[test]
fn test_start_stdin_positionless_comment_synthesizes_and_starts() {
    // 完了条件 1: position なし（ファイルレベル）コメントを stdin で渡しても起動に成功し、
    // difit に渡る時点で {"side":"new","line":1} が合成されている。
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let input = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "body": "[issue] file-level comment via stdin"
    }])
    .to_string();

    let output = run_mt_difit_start(&path, &input);
    assert!(
        output.status.success(),
        "position なしコメントでも起動に成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout が JSON であること");
    let port = json["port"].as_u64().expect("port");
    assert!(port > 0);

    // difit に渡した配列が状態に保存されている → 合成済み position を検証できる
    let state = shared::read_review_state(&path).expect("状態が保存されている");
    assert_eq!(
        state.comments[0]["position"],
        serde_json::json!({"side": "new", "line": 1}),
        "difit に渡る時点で position が合成されている"
    );

    // 合成された position でコメントがサーバに受理されている
    let resp = shared::fetch_comments(port as u16).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(
        resp.threads[0].messages[0].body,
        "[issue] file-level comment via stdin"
    );
    assert!(
        resp.threads[0].position.as_object().is_some(),
        "サーバ上でも position が付与されている"
    );

    // クリーンアップ
    shared::kill_server(state.pid);
    assert!(!shared::is_process_alive(state.pid));
}

#[test]
fn test_start_stale_positionless_saved_comments_synthesizes_and_recovers() {
    // 完了条件 3: 保存済みコメント（クラッシュ復旧パス）にも合成が適用される。
    // 旧バージョンが保存した position なしコメントを持つ stale 状態から復旧できる。
    let _guard = shared::DIFIT_TEST_LOCK.lock().unwrap();
    if !shared::difit_available() {
        eprintln!("SKIP: difit がインストールされていません");
        return;
    }

    let (_tmp, path) = shared::make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale 状態: 確実に存在しない PID + position なしコメント（旧保存形式を再現）
    shared::ensure_difit_dir(&path).unwrap();
    let stale = shared::ReviewState {
        port: 1,
        pid: 2_000_000_000,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "body": "[issue] stale file-level comment"
        })],
        difit_args: vec!["working".to_string()],
    };
    shared::write_review_state(&path, &stale).unwrap();

    // 空 stdin で起動 → 保存済みコメントで復旧（stdin 空なら保存済みが選ばれる）
    let output = run_mt_difit_start(&path, "");
    assert!(
        output.status.success(),
        "保存済み position なしコメントでも復旧起動に成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout が JSON であること");
    let port = json["port"].as_u64().expect("port");

    // 復旧後は position 合成済みのコメントが状態・サーバの両方に存在する
    let state = shared::read_review_state(&path).expect("新しい状態が保存されている");
    assert!(shared::is_process_alive(state.pid), "新しいサーバが起動している");
    assert_eq!(
        state.comments[0]["position"],
        serde_json::json!({"side": "new", "line": 1}),
        "保存済みコメントにも合成が適用されている"
    );

    let resp = shared::fetch_comments(port as u16).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(
        resp.threads[0].messages[0].body,
        "[issue] stale file-level comment"
    );

    // クリーンアップ
    shared::kill_server(state.pid);
    assert!(!shared::is_process_alive(state.pid));
}
