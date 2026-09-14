//! `mt difit resolve` のテスト。
//!
//! 同一性検証・選択固定・人間コメント拒否の契約を、実 difit バイナリを含めて固定する。
//! `difit comment resolve --port` の直叩きに戻ると、state ファイル由来の port へ
//! 無検証で DELETE が飛ぶ（無関係セッションのスレッド削除）ため、ここで挙動を固定する。

use super::*;
use crate::difit::{client, shared};
use crate::test_support::{make_temp_git_repo, require_difit, run_mt_with_env};

// ---------------------------------------------------------------------------
// ユニットテスト: fail-closed（resolve しない経路）
// ---------------------------------------------------------------------------

#[test]
fn test_resolve_cli_without_state_errors_without_silent_success() {
    let (_tmp, path) = make_temp_git_repo();
    let output = run_mt_with_env(&path, &["difit", "resolve", "t1"], "", &[]);
    assert!(!output.status.success(), "state なしは非 0 exit");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("レビューセッションがありません"),
        "原因が分かるエラーを出す: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "resolved と解釈できる JSON を出さない: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn test_resolve_in_without_selection_fails_closed() {
    // 選択キー未記録の state（選択固定前の旧形式）は、どのセッションのスレッドを
    // resolve すべきか確定できない。state・サーバを変更せず fail-closed で止める。
    let (_tmp, path) = make_temp_git_repo();
    let state = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: None,
    };
    shared::write_review_state(&path, &state).unwrap();

    let error = resolve_in(&path, "t1").expect_err("選択キーなしはエラー");
    assert!(
        error.to_string().contains("選択キー"),
        "無音で resolve しない: {error:#}"
    );
}

#[test]
fn test_resolve_in_with_dead_server_errors() {
    // サーバ死・同一性照合不能は stale 復旧も resolve もせず fail-closed にする。
    let (_tmp, path) = make_temp_git_repo();
    let state = shared::ReviewState {
        port: 9,
        pid: 2_000_000_000,
        comments: Vec::new(),
        difit_args: vec!["working".to_string()],
        selection: Some(client::CommentSelection {
            base: "staged".to_string(),
            target: "working".to_string(),
            base_mode: None,
        }),
    };
    shared::write_review_state(&path, &state).unwrap();

    let error = resolve_in(&path, "t1").expect_err("サーバ死はエラー");
    assert!(
        error.to_string().contains("同一性を確認できません"),
        "stale 復旧は行わず fail-closed にする: {error:#}"
    );
}

// ---------------------------------------------------------------------------
// 統合テスト: 実 difit サーバでの同一性検証・選択固定・人間コメント拒否
// ---------------------------------------------------------------------------

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

/// ヘルパー: 一時リポジトリで git コマンドを実行する（失敗時 panic）。
fn git_cmd(path: &std::path::Path, args: &[&str]) {
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

/// ヘルパー: working 選択でサーバを起動し、選択キーつき状態を保存する。
fn setup_server(path: &std::path::Path, comments: &[serde_json::Value]) -> shared::StartedServer {
    let difit_args = vec!["working".to_string()];
    let server = shared::start_difit_server(path, &difit_args, comments).expect("difit サーバ起動");
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.to_vec(),
        difit_args,
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(path, &state).unwrap();
    server
}

/// ヘルパー: 固定選択の未 resolve スレッドから最初の ID を返す。
fn pinned_thread_id(server: &shared::StartedServer) -> String {
    client::fetch_comments(server.port, Some(&server.selection))
        .expect("固定選択の取得")
        .threads
        .first()
        .expect("未 resolve スレッドがある")
        .id
        .clone()
}

#[cfg(unix)]
#[test]
fn test_resolve_cli_requires_server_identity() {
    // 記録 port では実 difit が応答しているが、記録 pid は無関係の生存プロセス
    // （PID 再利用・細工した state）。resolve は pid↔port LISTEN の照合前に
    // DELETE を送らず fail-closed で止まる。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "🚨 must · 🐛 issue · 🎯 req-1 | README.md:2 — bug"
    })];
    let running = setup_server(&path, &comments);
    let thread_id = pinned_thread_id(&running);

    let mut victim = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("検証用プロセスの起動");
    let victim_pid = victim.id() as i32;
    let state = shared::ReviewState {
        port: running.port,
        pid: victim_pid,
        comments: comments.clone(),
        difit_args: vec!["working".to_string()],
        selection: Some(running.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();

    let output = run_mt_with_env(&path, &["difit", "resolve", &thread_id], "", &[]);
    assert!(
        !output.status.success(),
        "同一性未確認では resolve しない: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "resolved と解釈できる JSON を出さない: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("同一性を確認できません"),
        "原因が分かるエラーを出す: {stderr}"
    );

    // 無関係プロセスからも difit サーバからも DELETE は飛んでいない
    assert!(
        shared::is_process_alive(victim_pid),
        "無関係プロセスを kill しない"
    );
    assert!(shared::is_process_alive(running.pid), "サーバを停止しない");
    let pinned = client::fetch_comments(running.port, Some(&running.selection)).unwrap();
    assert_eq!(
        pinned.threads.len(),
        1,
        "対象スレッドは削除されない: {pinned:?}"
    );

    shared::kill_server(running.pid);
    let _ = victim.kill();
    let _ = victim.wait();
}

#[test]
fn test_resolve_cli_rejects_human_thread() {
    // 親メッセージの author が User（人間）のスレッドは resolve を拒否する。
    // エージェントが人間コメントを独断で消す経路を塞ぎ、人間へ案内する。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();

    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 2},
        "body": "ここを直してください",
        "author": "User"
    })];
    let server = setup_server(&path, &comments);
    let thread_id = pinned_thread_id(&server);

    let output = run_mt_with_env(&path, &["difit", "resolve", &thread_id], "", &[]);
    assert!(
        !output.status.success(),
        "人間コメントは resolve しない: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "resolved と解釈できる JSON を出さない: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("人間") && stderr.contains("resolve"),
        "人間が resolve する案内を出す: {stderr}"
    );

    let pinned = client::fetch_comments(server.port, Some(&server.selection)).unwrap();
    assert_eq!(pinned.threads.len(), 1, "人間スレッドは残る: {pinned:?}");

    shared::kill_server(server.pid);
}

#[test]
fn test_resolve_cli_pins_selection_and_ignores_browser_switch() {
    // 人間がブラウザ UI のリビジョンセレクタで別の選択に切り替え、そのセッションに
    // 同名 ID のスレッドがあっても、resolve は state.selection に固定して元セッション
    // だけを消す（difit CLI の resolve は選択クエリを持たず切替先へ DELETE を送る）。
    let _guard = crate::test_support::difit_test_lock();
    if !require_difit() {
        return;
    }

    let (_tmp, path) = make_temp_git_repo();
    git_cmd(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
    git_cmd(&path, &["commit", "-aqm", "feature commit"]);
    std::fs::write(path.join("README.md"), "hello\nworld\nextra\n").unwrap();

    // merge-base 選択（起動時の state.selection）でスレッドを注入する
    let difit_args = crate::difit::start::translate_difit_args(&path, vec!["main".to_string()]);
    let body = "🚨 must · 🐛 issue · 🎯 req-1 | README.md:3 — bug";
    let comments = vec![serde_json::json!({
        "type": "thread",
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": body
    })];
    let server =
        shared::start_difit_server(&path, &difit_args, &comments).expect("difit サーバ起動");
    assert_eq!(
        server.selection.base_mode.as_deref(),
        Some("merge-base"),
        "前提: merge-base 選択が記録される"
    );
    let state = shared::ReviewState {
        port: server.port,
        pid: server.pid,
        comments: comments.clone(),
        difit_args,
        selection: Some(server.selection.clone()),
    };
    shared::write_review_state(&path, &state).unwrap();
    let thread_id = pinned_thread_id(&server);

    // ブラウザのリビジョン切替を再現（direct 選択へ）
    let head = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let main = String::from_utf8(
        crate::test_support::git_command()
            .args(["rev-parse", "--short", "main"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    http_get_json(server.port, &format!("/api/diff?base={main}&target={head}"));
    let switched = client::probe_selection(server.port).expect("切替後の選択");
    assert_ne!(switched, server.selection, "前提: 別セッションへ切り替わる");

    // 切替先セッションにも同じ ID のスレッドを置く（選択固定がなければ消える標的）
    let other_comments = vec![serde_json::json!({
        "type": "thread",
        "id": thread_id,
        "filePath": "README.md",
        "position": {"side": "new", "line": 3},
        "body": body
    })];
    client::add_comments(server.port, Some(&switched), &other_comments).expect("切替先へ注入");
    assert_eq!(
        client::fetch_comments(server.port, None)
            .expect("unpinned 取得")
            .threads
            .len(),
        1,
        "前提: unpinned 取得は切替先セッション（同一 ID）を読む"
    );

    // --- resolve: 固定選択（merge-base）のスレッドだけを消す ---
    let output = run_mt_with_env(&path, &["difit", "resolve", &thread_id], "", &[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "resolve は成功する: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout が JSON");
    assert_eq!(json["resolved"], true);
    assert_eq!(json["threadId"], thread_id);

    let pinned_after = client::fetch_comments(server.port, Some(&server.selection)).unwrap();
    assert!(
        pinned_after.threads.is_empty(),
        "固定選択のスレッドは resolve される: {pinned_after:?}"
    );
    let other_after = client::fetch_comments(server.port, Some(&switched)).unwrap();
    assert_eq!(
        other_after.threads.len(),
        1,
        "切替先セッションの同名スレッドは削除されない: {other_after:?}"
    );
    assert_eq!(other_after.threads[0].id, thread_id);

    // 2 回目（未 resolve に存在しない）は成功と区別して fail-closed にする
    let again = run_mt_with_env(&path, &["difit", "resolve", &thread_id], "", &[]);
    assert!(
        !again.status.success(),
        "resolve 済みの再実行は非 0 exit: stdout={}",
        String::from_utf8_lossy(&again.stdout)
    );
    assert!(
        again.stdout.is_empty(),
        "resolved と解釈できる JSON を出さない"
    );
    assert!(
        String::from_utf8_lossy(&again.stderr).contains("未 resolve スレッドにありません"),
        "原因が分かるエラーを出す: {}",
        String::from_utf8_lossy(&again.stderr)
    );

    shared::kill_server(server.pid);
}
