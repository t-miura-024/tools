//! `mt difit start` のテスト。
//!
//! 実 difit バイナリを使った統合テストを含む。
//! difit サーバのポート競合を避けるため、統合テストは Mutex で直列化する。
//! レビュー表示は URL 提示のみ（ADR-0027）であり、外部表示ツールが呼ばれない
//! ことをフェイク環境（DisplayToolProbe）で検証する。

use super::*;
use crate::difit::client;
use crate::test_support::{DisplayToolProbe, make_temp_git_repo, require_difit, run_mt_with_env};
use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// ユニットテスト: 引数変換ロジック（ADR-0008）
// ---------------------------------------------------------------------------

/// ヘルパー: Vec<&str> → Vec<String>
fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// ヘルパー: 引数変換を任意のリポジトリ文脈で実行する。
///
/// 非 hex の引数は git に問い合わせないため `Path::new(".")` でよい。
/// hex の引数は ref 実在確認の対象になるため、テストごとに一時リポジトリを渡す。
fn translate(cwd: &Path, v: &[&str]) -> Vec<String> {
    translate_difit_args(cwd, args(v))
}

#[test]
fn test_translate_single_branch_name() {
    // 単一ブランチ名 → "." を先頭に挿入 + --merge-base + 共通フラグ
    let result = translate(Path::new("."), &["main"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "main",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_single_branch_name_develop() {
    let result = translate(Path::new("."), &["develop"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "develop",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_dot_prefixed() {
    // 既に "." 付き → そのまま + フラグ追加（"." を二重に付けない）
    let result = translate(Path::new("."), &[".", "main"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "main",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_working() {
    // 特殊ターゲット → --merge-base 不要
    let result = translate(Path::new("."), &["working"]);
    assert_eq!(result, args(&["working", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_staged() {
    let result = translate(Path::new("."), &["staged"]);
    assert_eq!(result, args(&["staged", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_empty() {
    // 空 → そのまま透過
    let result = translate_difit_args(Path::new("."), vec![]);
    assert_eq!(result, Vec::<String>::new());
}

#[test]
fn test_translate_commit_ref_head_tilde() {
    let result = translate(Path::new("."), &["HEAD~3"]);
    assert_eq!(result, args(&["HEAD~3", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_commit_ref_head_caret() {
    let result = translate(Path::new("."), &["HEAD^2"]);
    assert_eq!(result, args(&["HEAD^2", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_commit_ref_head_plain() {
    let result = translate(Path::new("."), &["HEAD"]);
    assert_eq!(result, args(&["HEAD", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_commit_ref_sha() {
    // ref が実在しない 16 進数は従来どおりコミット参照として扱う
    let (_tmp, path) = make_temp_git_repo();
    let result = translate(&path, &["abc1234"]);
    assert_eq!(result, args(&["abc1234", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_commit_ref_full_sha() {
    let (_tmp, path) = make_temp_git_repo();
    let result = translate(&path, &["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"]);
    assert_eq!(
        result,
        args(&[
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_hex_branch_name_uses_merge_base() {
    // hex 名ブランチが実在する場合は SHA ヒューリスティックより ref を優先し、
    // ワーキングディレクトリ vs ベースブランチ（merge-base）モードにする。
    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["branch", "deadbeef"]);

    let result = translate(&path, &["deadbeef"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "deadbeef",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_short_hex_branch_name_uses_merge_base() {
    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["branch", "abcdef0"]);

    let result = translate(&path, &["abcdef0"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "abcdef0",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_hex_tag_name_uses_merge_base() {
    // タグも difit のベース指定として有効な ref のため、ブランチと同じ扱いにする
    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["tag", "deadbee"]);

    let result = translate(&path, &["deadbee"]);
    assert_eq!(
        result,
        args(&[
            ".",
            "deadbee",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );
}

#[test]
fn test_translate_branch_with_tilde_is_commit_ref() {
    let result = translate(Path::new("."), &["main~2"]);
    assert_eq!(result, args(&["main~2", "--clean", "--include-untracked"]));
}

#[test]
fn test_translate_multi_args_without_dot() {
    // 複数引数（"." なし）→ 共通フラグのみ付与（保守的フォールバック）
    let result = translate(Path::new("."), &["main", "feature"]);
    assert_eq!(
        result,
        args(&["main", "feature", "--clean", "--include-untracked"])
    );
}

// ---------------------------------------------------------------------------
// 統合テスト: untracked ファイルの取り込み（ADR-0009・difit 公式フラグ）
// ---------------------------------------------------------------------------

/// `--include-untracked` での起動 E2E: 親が JSON ハンドシェイクを期限内に返し、
/// untracked がサーバの diff に現れることを実 difit で固定する。
///
/// difit 5.0.12 の `--background` 親は IPC ハンドシェイクの JSON 1 行だけを stdout に
/// 出力し、子 stdout（untracked 追加時の "✅ Files added" 等）は `stdio: ignore` で
/// 転送しない。親が子の非 JSON 行を転送してハングするという旧 mt 実装の前提は
/// 成立しないため、mt 独自の `git add --intent-to-add` は行わず公式フラグを使う。
#[test]
fn test_include_untracked_flag_includes_untracked_files_in_diff() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(path.join("new-file.txt"), "untracked content\n").unwrap();
    std::fs::write(path.join("ignored.txt"), "ignored content\n").unwrap();
    std::fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();

    let difit_args = translate_difit_args(&path, args(&["main"]));
    assert!(
        difit_args.contains(&"--include-untracked".to_string()),
        "共通フラグに --include-untracked が含まれる: {difit_args:?}"
    );

    // start_difit_server は --background の JSON ハンドシェイクが期限内に得られなければ
    // エラーになる（子の "✅ Files added" を転送してハングすればここで失敗する）。
    let server = shared::start_difit_server(&path, &difit_args, &[])
        .expect("--include-untracked 付きで difit サーバが起動する");

    let diff = http_get_json(server.port, "/api/diff");
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
    assert!(
        !file_paths.contains(&"ignored.txt"),
        "gitignore 対象は diff に含まれない: {file_paths:?}"
    );

    shared::kill_server(server.pid);
    assert!(!shared::is_process_alive(server.pid));
}

/// `mt difit start`（CLI 経路）でも untracked が diff に現れ、stdout の JSON が
/// 期限内に返ることを実 difit で固定する。
#[test]
fn test_start_cli_includes_untracked_files_in_diff() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(path.join("new-file.txt"), "untracked content\n").unwrap();

    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(
        output.status.success(),
        "untracked があっても start がハングせず成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout が JSON であること");

    let state = shared::read_review_state(&path).expect("状態が保存される");
    assert!(
        state
            .difit_args
            .contains(&"--include-untracked".to_string()),
        "state の difit_args に公式フラグが記録される: {:?}",
        state.difit_args
    );

    let diff = http_get_json(json["port"].as_u64().expect("port") as u16, "/api/diff");
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

    shared::kill_server(state.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 difit サーバ起動（コメント注入・状態保存）
// ---------------------------------------------------------------------------

#[test]
fn test_start_spawns_server_and_writes_state() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] test comment"
    });

    let bg = shared::start_difit_server(
        &path,
        &["working".to_string()],
        std::slice::from_ref(&comment),
    )
    .expect("difit サーバ起動");

    assert!(bg.port > 0);
    assert!(bg.pid > 0);
    assert!(shared::is_process_alive(bg.pid));

    shared::ensure_difit_dir(&path).unwrap();
    let state = shared::ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments: vec![comment],
        difit_args: vec!["working".to_string()],
        selection: Some(bg.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    assert!(shared::difit_dir(&path).exists());
    let loaded = shared::read_review_state(&path).expect("state が読み込める");
    assert_eq!(loaded.port, bg.port);
    assert_eq!(loaded.pid, bg.pid);

    let resp = client::fetch_comments(bg.port, Some(&bg.selection)).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(resp.threads[0].messages[0].body, "[issue] test comment");

    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));
}

/// clone 先に仕込まれた一時ファイル symlink を start が追従しない。
#[cfg(unix)]
#[test]
fn test_start_does_not_follow_planted_tmp_symlink() {
    use std::os::unix::fs::symlink;

    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // 攻撃: 固定名の一時ファイルを symlink として仕込み、state 更新のたびに
    // リンク先の任意ファイルを truncate 上書きさせる。
    let dir = shared::difit_dir(&path);
    std::fs::create_dir_all(&dir).unwrap();
    let victim = path.join("victim.txt");
    std::fs::write(&victim, "do not touch\n").unwrap();
    let planted = shared::review_state_path(&path).with_extension("json.tmp");
    symlink(&victim, &planted).unwrap();

    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(
        output.status.success(),
        "symlink を無視して start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "do not touch\n",
        "symlink のリンク先を書き換えない"
    );
    assert!(
        shared::read_review_state(&path).is_some(),
        "state は保存される"
    );

    let state = shared::read_review_state(&path).expect("state");
    shared::kill_server(state.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: 実行中サーバの再利用（次ラウンドでのコメント追記）
// ---------------------------------------------------------------------------

#[test]
fn test_start_reuses_running_server_and_adds_comments() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let first = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] first round"
    }]);
    let output = run_mt_difit_start(&path, &first.to_string(), &["working"]);
    assert!(
        output.status.success(),
        "1 回目の start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state1 = shared::read_review_state(&path).expect("状態が保存される");

    let second = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] second round"
    }]);
    let output = run_mt_difit_start(&path, &second.to_string(), &["working"]);
    assert!(
        output.status.success(),
        "2 回目の start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state2 = shared::read_review_state(&path).expect("状態が更新される");

    assert_eq!(state1.pid, state2.pid, "サーバは再起動されず再利用される");
    assert_eq!(state1.port, state2.port, "ポートも維持される");

    let resp =
        client::fetch_comments(state2.port, state2.selection.as_ref()).expect("コメント取得");
    assert_eq!(resp.threads.len(), 2, "両ラウンドのコメントが存在する");
    assert_eq!(
        state2.comments.len(),
        2,
        "状態に未 resolve コメントが集約される"
    );

    shared::kill_server(state2.pid);
}

#[test]
fn test_start_reuse_is_idempotent_for_same_comments() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] same round retry"
    }]);

    let output = run_mt_difit_start(&path, &comments.to_string(), &["working"]);
    assert!(output.status.success());
    let output = run_mt_difit_start(&path, &comments.to_string(), &["working"]);
    assert!(output.status.success());

    let state = shared::read_review_state(&path).expect("状態が保存される");
    let resp = client::fetch_comments(state.port, state.selection.as_ref()).expect("コメント取得");
    assert_eq!(
        resp.threads.len(),
        1,
        "同一 import は重複しない（difit の冪等契約）"
    );

    shared::kill_server(state.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: resolve 済み除外と stale 復旧（サーバ復旧契約）
// ---------------------------------------------------------------------------

#[test]
fn test_resolved_threads_are_not_reinjected_after_restart() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = serde_json::json!([
        {
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 1},
            "body": "[issue] problem"
        },
        {
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 2},
            "body": "[context] info"
        }
    ]);
    let output = run_mt_difit_start(&path, &comments.to_string(), &["working"]);
    assert!(output.status.success());
    let state = shared::read_review_state(&path).unwrap();

    // [issue] スレッドを resolve（difit の resolve 契約: get から消える）
    let resp = client::fetch_comments(state.port, state.selection.as_ref()).unwrap();
    assert_eq!(resp.threads.len(), 2);
    let issue_id = resp
        .threads
        .iter()
        .find(|t| t.messages[0].body.starts_with("[issue]"))
        .unwrap()
        .id
        .clone();
    let resolve_output = crate::git::common::command_with_clean_git_context("difit")
        .args([
            "comment",
            "resolve",
            "--port",
            &state.port.to_string(),
            &issue_id,
        ])
        .output()
        .expect("resolve");
    assert!(resolve_output.status.success());

    // 空 stdin で start（実行中サーバ再利用）→ 状態が未 resolve のみへ更新される
    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(output.status.success());
    let refreshed = shared::read_review_state(&path).unwrap();
    assert_eq!(refreshed.comments.len(), 1, "resolve 済みは状態から消える");

    // サーバを kill して stale を再現 → 復旧起動で resolve 済みが復活しない
    shared::kill_server(refreshed.pid);
    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(
        output.status.success(),
        "stale 復旧起動が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let recovered = shared::read_review_state(&path).unwrap();
    assert_ne!(recovered.pid, refreshed.pid, "新しいサーバが起動する");
    let resp = client::fetch_comments(recovered.port, recovered.selection.as_ref()).unwrap();
    assert_eq!(resp.threads.len(), 1, "resolve 済みは再注入されない");
    assert_eq!(resp.threads[0].messages[0].body, "[context] info");

    shared::kill_server(recovered.pid);
}

#[test]
fn test_reinject_reply_roundtrip() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let thread_comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "[issue] parent thread"
    });
    let bg1 = shared::start_difit_server(&path, &["working".to_string()], &[thread_comment])
        .expect("初回起動");

    let resp1 = client::fetch_comments(bg1.port, Some(&bg1.selection)).unwrap();
    assert_eq!(resp1.threads.len(), 1);
    let thread_id = resp1.threads[0].id.clone();

    // reply を追加（human reply は thread_blocks の昇格判定にも使う）
    let reply_json = serde_json::json!({
        "type": "reply",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "this is a reply",
        "author": "User"
    });
    client::add_comments(bg1.port, Some(&bg1.selection), &[reply_json]).expect("reply 追加");

    let resp_with_reply = client::fetch_comments(bg1.port, Some(&bg1.selection)).unwrap();
    assert_eq!(resp_with_reply.threads[0].messages.len(), 2);
    assert_eq!(
        resp_with_reply.threads[0].messages[1].author.as_deref(),
        Some("User"),
        "reply の author が取得できる"
    );

    let reimport = shared::threads_to_import_comments(&resp_with_reply.threads);
    assert_eq!(reimport.len(), 2, "thread 1 + reply 1 = 2 エントリ");
    assert_eq!(reimport[1]["type"], "reply");
    assert_eq!(
        reimport[1]["author"], "User",
        "再注入用 JSON に author が保持される"
    );
    assert!(
        reimport[1].get("parentId").is_none(),
        "parentId はスキーマ外"
    );

    // kill（クラッシュ模擬）→ 再注入で再起動
    shared::kill_server(bg1.pid);

    let bg2 =
        shared::start_difit_server(&path, &["working".to_string()], &reimport).expect("再注入起動");

    let resp2 = client::fetch_comments(bg2.port, Some(&bg2.selection)).unwrap();
    assert_eq!(resp2.threads.len(), 1, "スレッドは 1 つ");
    assert_eq!(resp2.threads[0].messages.len(), 2, "reply が再付着している");
    assert_eq!(resp2.threads[0].messages[0].body, "[issue] parent thread");
    assert_eq!(resp2.threads[0].messages[1].body, "this is a reply");
    assert_eq!(resp2.threads[0].id, thread_id, "スレッド ID が維持される");

    shared::kill_server(bg2.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: 変換後引数による merge-base コメント配信エンドツーエンド
// （ADR-0008 回帰テスト）
// ---------------------------------------------------------------------------

/// ヘルパー: 指定リポジトリで git コマンドを実行する（失敗時 panic）。
fn git_cmd(path: &Path, args: &[&str]) {
    let output = crate::test_support::git_command()
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

#[test]
fn test_merge_base_args_delivers_comments_end_to_end() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    // 一時リポジトリ: main（ベースブランチ）→ 作業ブランチでコミット（乖離）→ ワーキングディレクトリ変更。
    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();
    std::fs::write(path.join("new-file.txt"), "untracked content\n").unwrap();

    // 引数変換（ADR-0008）: ["main"] → [".", "main", "--merge-base", "--clean", "--include-untracked"]
    let difit_args = translate_difit_args(&path, args(&["main"]));
    assert_eq!(
        difit_args,
        args(&[
            ".",
            "main",
            "--merge-base",
            "--clean",
            "--include-untracked"
        ])
    );

    let comment = serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": "[issue] merge-base delivery regression"
    });

    let bg = shared::start_difit_server(&path, &difit_args, &[comment])
        .expect("変換後引数での difit サーバ起動");
    assert!(shared::is_process_alive(bg.pid));
    assert_eq!(
        bg.selection.base_mode.as_deref(),
        Some("merge-base"),
        "起動時の解決済み選択が記録される"
    );

    // 1. コメントは起動 argv（--comment）ではなく、選択確定後の HTTP import で注入される。
    //    起動時 import を持たないため /api/diff の commentImports は省略される。
    let diff = http_get_json(bg.port, "/api/diff");
    assert!(
        diff["commentImports"].is_null(),
        "コメントは起動 argv ではなく HTTP で注入される: {diff}"
    );

    // diff セマンティクス: ワーキングディレクトリ vs ベースブランチの merge-base 解決
    assert_eq!(diff["requestedBaseCommitish"], "main");
    assert_eq!(diff["targetCommitish"], ".");
    assert_eq!(diff["requestedBaseMode"], "merge-base");
    assert_eq!(diff["clearComments"], true, "--clean がサーバに反映される");
    assert_eq!(diff["files"][0]["path"], "README.md");

    // ADR-0009: --include-untracked（difit 自身が intent-to-add する）で diff に含まれる
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

    // 2. ブラウザのコメントブートストラップを再現: /api/comments-json
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

    // 3. fetch_comments（mt difit check が使う経路）でも取得できる
    let resp = client::fetch_comments(bg.port, Some(&bg.selection)).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);

    // 選択クエリなしの取得と同じセッションを指す（選択キーの契約）
    let unpinned = client::fetch_comments(bg.port, None).expect("unpinned 取得");
    assert_eq!(unpinned.threads.len(), 1, "切替前は同一セッションを読む");

    shared::kill_server(bg.pid);
    assert!(!shared::is_process_alive(bg.pid));
}

#[test]
fn test_start_with_hex_branch_name_keeps_working_directory_in_scope() {
    // hex 名ブランチ（deadbeef）をベースに指定したとき、SHA ヒューリスティックに
    // 誤判定されて [<rev>^..<rev>] になると、ワーキングディレクトリの未コミット
    // 変更が diff から落ちる。merge-base モードで起動されることを実 difit で固定する。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["branch", "deadbeef"]);
    // ベースブランチとの乖離（コミット済み）+ 未コミット変更の両方を作る
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "hex branch commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    let output = run_mt_with_env(&path, &["difit", "start", "deadbeef"], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "hex 名ブランチで start が成功する: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let state = shared::read_review_state(&path).expect("状態が保存される");
    assert_eq!(
        state
            .selection
            .as_ref()
            .and_then(|s| s.base_mode.as_deref()),
        Some("merge-base"),
        "hex 名ブランチでも merge-base モードになる"
    );

    // 未コミット変更が diff に含まれる（ワーキングディレクトリ vs ベースブランチ）
    let diff = http_get_json(state.port, "/api/diff");
    assert_eq!(diff["requestedBaseCommitish"], "deadbeef");
    assert_eq!(diff["targetCommitish"], ".");
    assert_eq!(diff["requestedBaseMode"], "merge-base");
    let file_paths: Vec<&str> = diff["files"]
        .as_array()
        .expect("files が配列")
        .iter()
        .map(|f| f["path"].as_str().expect("path"))
        .collect();
    assert!(
        file_paths.contains(&"README.md"),
        "未コミット変更が diff に含まれる: {file_paths:?}"
    );

    shared::kill_server(state.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: position なしコメントの起動（ADR-0011）
// ---------------------------------------------------------------------------

/// 実 `mt` バイナリで `mt difit start` を実行する（stdin は指定入力）。
fn run_mt_difit_start(path: &Path, stdin_input: &str, extra_args: &[&str]) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;

    let mut command = Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let mut child = command
        .args(["difit", "start"])
        .args(extra_args)
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
    // position なし（ファイルレベル）コメントを stdin で渡しても起動に成功し、
    // difit に渡る時点で {"side":"new","line":1} が合成されている。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let input = serde_json::json!([{
        "type": "thread",
        "filePath": "README.md",
        "body": "[issue] file-level comment via stdin"
    }])
    .to_string();

    let output = run_mt_difit_start(&path, &input, &["working"]);
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
    assert_eq!(json["comments"], 1);

    let state = shared::read_review_state(&path).expect("状態が保存されている");
    assert_eq!(
        state.comments[0]["position"],
        serde_json::json!({"side": "new", "line": 1}),
        "difit に渡る時点で position が合成されている"
    );

    let resp = client::fetch_comments(port as u16, state.selection.as_ref()).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(
        resp.threads[0].messages[0].body,
        "[issue] file-level comment via stdin"
    );
    assert!(
        resp.threads[0].position.as_object().is_some(),
        "サーバ上でも position が付与されている"
    );

    shared::kill_server(state.pid);
    assert!(!shared::is_process_alive(state.pid));
}

#[test]
fn test_start_stale_positionless_saved_comments_synthesizes_and_recovers() {
    // 保存済みコメント（クラッシュ復旧パス）にも合成が適用される。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // stale 状態: 確実に存在しない PID + position なしコメント（旧保存形式を再現）。
    // selection も旧形式（未記録）とし、保存済みコメントからの復旧パスを通す。
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
        selection: None,
    };
    shared::write_review_state(&path, &stale).unwrap();

    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(
        output.status.success(),
        "保存済み position なしコメントでも復旧起動に成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout が JSON であること");
    let port = json["port"].as_u64().expect("port");

    let state = shared::read_review_state(&path).expect("新しい状態が保存されている");
    assert!(
        shared::is_process_alive(state.pid),
        "新しいサーバが起動している"
    );
    assert!(
        state.selection.is_some(),
        "復旧時に新しい選択キーが記録される"
    );
    assert_eq!(
        state.comments[0]["position"],
        serde_json::json!({"side": "new", "line": 1}),
        "保存済みコメントにも合成が適用されている"
    );

    let resp = client::fetch_comments(port as u16, state.selection.as_ref()).expect("コメント取得");
    assert_eq!(resp.threads.len(), 1);
    assert_eq!(
        resp.threads[0].messages[0].body,
        "[issue] stale file-level comment"
    );

    shared::kill_server(state.pid);
}

#[test]
fn test_start_injects_large_comment_set_and_recovers_stale_state() {
    // コメント全量を argv（--comment）で渡すと OS の引数長上限で E2BIG になる。
    // 起動後に HTTP（/api/comment-imports）で注入するため、合計 1 MiB 超の
    // コメントでも start と stale 復旧（保存済みコメントの再注入）が成立する。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // 1 件あたりは difit の HTTP 取込上限（100kb）未満に収め、合計で 1 MiB 超にする
    let comments: Vec<serde_json::Value> = (0..30)
        .map(|index| {
            serde_json::json!({
                "type": "thread",
                "filePath": "README.md",
                "position": {"side": "new", "line": 2},
                "body": format!(
                    "🚨 must · 🐛 issue · 🎯 req-1 | README.md:2 — large {index} {}",
                    "x".repeat(40 * 1024)
                ),
            })
        })
        .collect();
    let input = serde_json::Value::Array(comments.clone()).to_string();
    assert!(
        input.len() > 1024 * 1024,
        "前提: コメント全量が 1 MiB を超える ({} bytes)",
        input.len()
    );

    let output = run_mt_difit_start(&path, &input, &["working"]);
    assert!(
        output.status.success(),
        "1 MiB 超のコメントでも起動できること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let state = shared::read_review_state(&path).expect("状態が保存されている");
    assert_eq!(state.comments.len(), 30);
    let resp = client::fetch_comments(state.port, state.selection.as_ref()).expect("コメント取得");
    assert_eq!(resp.threads.len(), 30, "全件が HTTP 注入される");

    // stale 復旧: サーバを停止して start し直すと、保存済みコメント全量が再注入される
    shared::kill_server(state.pid);
    assert!(!shared::is_process_alive(state.pid));

    let output = run_mt_difit_start(&path, "", &["working"]);
    assert!(
        output.status.success(),
        "stale 復旧でも 1 MiB 超の再注入が成立すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let recovered = shared::read_review_state(&path).expect("復旧後の状態が保存される");
    assert_ne!(recovered.pid, state.pid, "新しいサーバで復旧する");
    let resp = client::fetch_comments(recovered.port, recovered.selection.as_ref())
        .expect("復旧後のコメント取得");
    assert_eq!(resp.threads.len(), 30, "復旧後も全件が再注入される");

    shared::kill_server(recovered.pid);
}

// ---------------------------------------------------------------------------
// 統合テスト: レビュー表示は URL 提示のみ（ADR-0027）
// ---------------------------------------------------------------------------

/// `mt difit start` は外部表示ツールを呼ばず、stdout JSON に URL を提示する。
/// 新規起動と実行中サーバの再利用のどちらでも外部表示ツールを呼ばず、
/// state にも表示ツールの情報（旧 tab フィールド）を残さない。
#[test]
fn test_start_presents_url_without_calling_display_tools() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    let probe = DisplayToolProbe::new();

    // 新規起動: PATH 上の外部表示ツールはフェイクが記録する
    let output = run_mt_with_env(&path, &["difit", "start", "working"], "", &probe.envs());
    assert!(
        output.status.success(),
        "start が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    let port = json["port"].as_u64().expect("port");
    assert_eq!(
        json["url"].as_str().expect("url"),
        format!("http://localhost:{port}"),
        "レビュー表示は URL の提示のみ"
    );

    // 再入（実行中サーバの再利用）でも外部表示ツールを呼ばない
    let output = run_mt_with_env(&path, &["difit", "start", "working"], "", &probe.envs());
    assert!(
        output.status.success(),
        "再入が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(
        probe.calls().is_empty(),
        "外部表示ツールを呼ばない: {:?}",
        probe.calls()
    );

    // state に表示ツールの情報（旧 tab フィールド）を保存しない
    let state_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(shared::review_state_path(&path)).expect("state 読み取り"),
    )
    .expect("state が JSON");
    assert!(
        state_json.get("tab").is_none(),
        "state に tab 情報を保存しない: {state_json}"
    );

    let state = shared::read_review_state(&path).expect("状態が保存される");
    shared::kill_server(state.pid);
}

// ---------------------------------------------------------------------------
// 再起動の順序契約: 新サーバの起動と状態保存が完了するまで旧 state を壊さない
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn test_start_restart_keeps_unrelated_pid_even_when_recorded_port_responds() {
    // 記録 port では本物の difit が応答しているが、state の pid は無関係の生存
    // プロセス（細工・PID 再利用）。difit 引数の変更で再起動経路（restart_session
    // の旧サーバ停止）を通しても、この pid を kill してはならない。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let running =
        shared::start_difit_server(&path, &["working".to_string()], &[]).expect("difit サーバ起動");
    let mut victim = Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    let state = shared::ReviewState {
        port: running.port,
        pid: victim_pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(running.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    // "working" → "staged" の引数変更で再起動パスを通す
    let output = run_mt_difit_start(&path, "", &["staged"]);
    assert!(
        output.status.success(),
        "再起動が成功すること: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("停止対象にしません"),
        "同一性未確認で kill をスキップした警告が出る: {stderr}"
    );
    assert!(
        shared::is_process_alive(victim_pid),
        "無関係 pid を kill しない"
    );
    assert!(
        shared::is_process_alive(running.pid),
        "記録 port で応答中でも state 上の同一性が確認できない pid は kill しない"
    );

    let restarted = shared::read_review_state(&path).expect("新しい状態が保存される");
    assert_ne!(restarted.pid, victim_pid, "新しいサーバで再起動する");
    assert!(shared::is_process_alive(restarted.pid));

    shared::kill_server(running.pid);
    shared::kill_server(restarted.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

/// LISTEN の照合は取れるが difit として応答しない（コメント回収不能な）旧サーバを
/// restart_session が kill せず、専用の孤児警告を出す。
#[cfg(unix)]
#[test]
fn test_restart_warns_orphan_when_recorded_server_listens_but_fetch_fails() {
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }
    let Some(listener) = crate::test_support::UnresponsiveListener::spawn() else {
        eprintln!("SKIP: nc が利用できません");
        return;
    };

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    // 旧 state: 記録 pid が記録 port を LISTEN しているが、500 を返すため probe /
    // fetch が失敗する（未回収コメントの唯一の保持者であり得る旧サーバ）。
    let prior = shared::ReviewState {
        port: listener.port,
        pid: listener.pid,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &prior).unwrap();

    // difit 引数の変更（working → staged）で restart_session の旧サーバ停止経路を通す
    let output = run_mt_difit_start(&path, "", &["staged"]);
    assert!(
        output.status.success(),
        "再起動が成功すること: {}",
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

    let restarted = shared::read_review_state(&path).expect("新しい状態が保存される");
    assert_ne!(restarted.pid, listener.pid, "新しいサーバで再起動する");
    assert!(shared::is_process_alive(restarted.pid));
    shared::kill_server(restarted.pid);
}

#[cfg(unix)]
#[test]
fn test_restart_spawn_failure_keeps_prior_state() {
    use std::os::unix::fs::PermissionsExt;

    let (_repo_tmp, repo) = make_temp_git_repo();

    // 旧 state: 死んだ PID + 未 resolve コメント + 選択キー。
    // restart_session は spawn より前に state を削除しない。
    let prior = shared::ReviewState {
        port: 1,
        pid: 2_000_000_000,
        comments: vec![serde_json::json!({
            "type": "thread",
            "filePath": "README.md",
            "position": {"side": "new", "line": 1},
            "body": "[issue] prior round comment"
        })],
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&repo, &prior).unwrap();

    // spawn が即座に失敗する fake difit（出力なしで終了）
    let fake_bin_dir = tempfile::tempdir().unwrap();
    let fake_difit = fake_bin_dir.path().join("difit");
    std::fs::write(&fake_difit, "#!/bin/sh\nexit 1\n").unwrap();
    let mut permissions = std::fs::metadata(&fake_difit).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_difit, permissions).unwrap();
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let fake_path = format!(
        "{}:{}",
        fake_bin_dir.path().display(),
        original_path.to_string_lossy()
    );

    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    let output = command
        .args(["difit", "start", "working"])
        .current_dir(&repo)
        .env("PATH", &fake_path)
        .output()
        .expect("mt difit start の実行");
    assert!(
        !output.status.success(),
        "spawn 失敗はエラーになること: {}",
        String::from_utf8_lossy(&output.stdout)
    );

    // 旧 state（未 resolve コメント・選択キー）が復旧源として残る
    let kept = shared::read_review_state(&repo).expect("spawn 失敗時は旧 state を残す");
    assert_eq!(kept.pid, prior.pid);
    assert_eq!(kept.comments, prior.comments);
    assert_eq!(kept.selection, prior.selection);
    assert!(
        shared::review_state_path(&repo).exists(),
        "状態ファイルは削除されない"
    );
}
