use super::entry::WorktreeEntry;
use super::*;

fn entry(path: &str) -> WorktreeEntry {
    WorktreeEntry {
        path: path.to_string(),
        head: None,
        branch: None,
        is_bare: false,
        is_detached: false,
        shortstat: String::new(),
    }
}

#[test]
fn test_next_worktree_index_empty() {
    let entries: Vec<WorktreeEntry> = vec![];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

#[test]
fn test_next_worktree_index_only_main() {
    let entries = vec![entry("/Users/mt/src/tools")];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

#[test]
fn test_next_worktree_index_increments() {
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 2);
}

#[test]
fn test_next_worktree_index_finds_max() {
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/src/tools-wt-2"),
        entry("/Users/mt/src/tools-wt-5"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 6);
}

#[test]
fn test_next_worktree_index_does_not_reuse_holes() {
    // wt-1 と wt-3 があり wt-2 が欠番 → 4 を作る（穴埋めしない）
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/src/tools-wt-3"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 4);
}

#[test]
fn test_next_worktree_index_filters_by_parent() {
    // 同じ repo 名でも親ディレクトリが違えばカウントしない
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/other/tools-wt-9"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 2);
}

#[test]
fn test_next_worktree_index_filters_by_repo_name() {
    // 同じ親でも別 repo の wt はカウントしない
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/other-wt-1"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

// 実 git を一時ディレクトリに作って branch_exists / push_branch を検証。

fn run_git(cwd: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .status()
        .expect("git コマンドの起動に失敗しました");
    assert!(status.success(), "git {:?} が失敗", args);
}

fn make_temp_git_repo(branch: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir 作成失敗");
    let path = tmp.path().to_path_buf();
    run_git(&path, &["init", "-q", "-b", branch]);
    run_git(&path, &["config", "user.email", "test@test.local"]);
    run_git(&path, &["config", "user.name", "test"]);
    std::fs::write(path.join("README.md"), "hello\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "initial"]);
    (tmp, path)
}

#[test]
fn test_branch_exists_true() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature-branch"]);
    run_git(&path, &["checkout", "-q", "main"]);

    assert!(branch_exists(&path, "feature-branch"));
}

#[test]
fn test_branch_exists_false() {
    let (_tmp, path) = make_temp_git_repo("main");
    assert!(!branch_exists(&path, "nonexistent"));
}

// push_branch のテスト: 実 git + 一時ディレクトリ + ローカル bare remote

fn make_temp_bare_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("bare tempdir 作成失敗");
    let path = tmp.path().to_path_buf();
    run_git(&path, &["init", "-q", "--bare"]);
    (tmp, path)
}

fn attach_origin(local: &Path, bare: &Path) {
    run_git(local, &["remote", "add", "origin", bare.to_str().unwrap()]);
}

#[test]
fn test_push_branch_success() {
    let (_tmp_local, local) = make_temp_git_repo("main");
    let (_tmp_bare, bare) = make_temp_bare_repo();
    attach_origin(&local, &bare);

    // 新しい branch を作成して commit を積む
    run_git(&local, &["checkout", "-q", "-b", "tools-wt-test"]);
    std::fs::write(local.join("feature.txt"), "f\n").unwrap();
    run_git(&local, &["add", "."]);
    run_git(&local, &["commit", "-qm", "feature commit"]);

    // 初期状態: bare remote には branch が存在しない
    let before = common::command_output("git", &["-C", bare.to_str().unwrap(), "branch"])
        .expect("bare remote の branch 取得");
    assert!(
        !before.contains("tools-wt-test"),
        "push 前に branch が存在してはいけない: {before}"
    );

    push_branch(&local, "tools-wt-test").expect("push が成功するはず");

    // push 後に bare remote に branch が現れる
    let after = common::command_output("git", &["-C", bare.to_str().unwrap(), "branch"])
        .expect("bare remote の branch 取得 (push 後)");
    assert!(
        after.contains("tools-wt-test"),
        "push 後に branch が origin に存在すべき: {after}"
    );

    // upstream が origin/tools-wt-test に設定されているはず
    let upstream = common::command_output(
        "git",
        &[
            "-C",
            local.to_str().unwrap(),
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
    )
    .expect("upstream 取得");
    assert_eq!(upstream, "origin/tools-wt-test");
}

#[test]
fn test_push_branch_no_origin_fails() {
    let (_tmp_local, local) = make_temp_git_repo("main");
    run_git(&local, &["checkout", "-q", "-b", "tools-wt-noorigin"]);
    std::fs::write(local.join("a.txt"), "a\n").unwrap();
    run_git(&local, &["add", "."]);
    run_git(&local, &["commit", "-qm", "x"]);

    // origin が未設定なら push は失敗する
    let result = push_branch(&local, "tools-wt-noorigin");
    let err = format!(
        "{:#}",
        result.expect_err("origin 無しで push が成功してはいけない")
    );
    assert!(
        err.contains("git push"),
        "エラーメッセージに 'git push' が含まれるべき: {err}"
    );
}

#[test]
fn test_push_branch_missing_repo_path() {
    // 存在しないパスでも -C で起動はするため、git 側のエラーが返る
    let result = push_branch(Path::new("/nonexistent/path/to/repo"), "any-branch");
    let err = result.expect_err("存在しないパスでは push 失敗のはず");
    let err_msg = format!("{:#}", err);
    assert!(
        err_msg.contains("git push"),
        "エラーメッセージに 'git push' が含まれるべき: {err_msg}"
    );
}
