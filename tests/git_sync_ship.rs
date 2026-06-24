use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use assert_cmd::Command;
use tempfile::TempDir;

fn run_git(cwd: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .current_dir(cwd)
        .args(args)
        .status()
        .expect("git の起動に失敗しました");
    assert!(status.success(), "git {:?} が失敗", args);
}

fn run_git_output(cwd: &Path, args: &[&str]) -> String {
    let output = StdCommand::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git の起動に失敗しました");
    assert!(output.status.success(), "git {:?} が失敗", args);
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string()
}

struct TestRepo {
    _tmp: TempDir,
    repo: PathBuf,
    bare: PathBuf,
}

impl TestRepo {
    fn tmp_path(&self) -> &Path {
        self._tmp.path()
    }
}

fn setup_test_repo() -> TestRepo {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path().join("repo");
    let bare = tmp.path().join("bare.git");
    std::fs::create_dir(&repo).unwrap();

    // bare リポジトリを main ブランチで初期化
    run_git(
        tmp.path(),
        &["init", "--bare", "-q", "-b", "main", bare.to_str().unwrap()],
    );

    // 通常リポジトリを初期化して bare に push
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["config", "user.email", "test@test.local"]);
    run_git(&repo, &["config", "user.name", "test"]);
    run_git(&repo, &["config", "commit.gpgsign", "false"]);
    run_git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);

    std::fs::write(repo.join("README.md"), "initial\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-qm", "initial"]);
    run_git(&repo, &["push", "-u", "-q", "origin", "main"]);

    TestRepo {
        _tmp: tmp,
        repo,
        bare,
    }
}

#[test]
fn test_mt_git_sync_pulls_target_into_feature() {
    let repo = setup_test_repo();

    // feature branch を作成 & push（origin/feature を用意）
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit"]);

    // main に追加変更を push（feature にない状態）
    run_git(&repo.repo, &["checkout", "-q", "main"]);
    std::fs::write(repo.repo.join("main_update.txt"), "main update\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "main update"]);
    run_git(&repo.repo, &["push", "-q", "origin", "main"]);

    // feature に戻り、追加 commit を作成（feature を main の祖先でなくす）
    run_git(&repo.repo, &["checkout", "-q", "feature"]);
    std::fs::write(repo.repo.join("feature2.txt"), "feature work 2\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit 2"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    // mt git sync を実行
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target")
        .arg("main")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // feature に main の変更が取り込まれているはず（ff で進められる）
    let log = run_git_output(&repo.repo, &["log", "--oneline"]);
    assert!(
        log.contains("main update"),
        "feature に main の変更が取り込まれていない: {log}"
    );
    assert!(
        log.contains("feature commit"),
        "feature の commit が保持されているべき: {log}"
    );
    assert!(
        log.contains("feature commit 2"),
        "feature commit 2 が保持されているべき: {log}"
    );

    // ファイルも確認
    assert!(
        repo.repo.join("feature.txt").exists(),
        "feature.txt が保持されているべき"
    );
    assert!(
        repo.repo.join("feature2.txt").exists(),
        "feature2.txt が保持されているべき"
    );
    assert!(
        repo.repo.join("main_update.txt").exists(),
        "main_update.txt が取り込まれているべき"
    );
}

#[test]
fn test_mt_git_sync_errors_on_protected_branch() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "main"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target")
        .arg("main")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_ship_merges_feature_into_main() {
    let repo = setup_test_repo();

    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .arg("--message")
        .arg("ship from test")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // ローカル main に feature の変更がマージされているはず
    run_git(&repo.repo, &["checkout", "-q", "main"]);
    let log = run_git_output(&repo.repo, &["log", "--oneline"]);
    assert!(
        log.contains("feature commit"),
        "main に feature の変更がマージされていない: {log}"
    );
    assert!(
        log.contains("ship from test"),
        "ship commit メッセージが見つからない: {log}"
    );

    // リモート bare リポジトリにも push されているはず
    let remote_log = run_git_output(&repo.bare, &["log", "--oneline", "main"]);
    assert!(
        remote_log.contains("feature commit"),
        "リモート main に feature の変更が push されていない: {remote_log}"
    );
}

#[test]
fn test_mt_git_ship_errors_on_protected_branch() {
    let repo = setup_test_repo();

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_sync_nonexistent_target_errors() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target")
        .arg("nonexistent-branch")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_ship_auto_message_for_feature_commit() {
    let repo = setup_test_repo();

    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    // 未 commit の変更（feature.txt を新規作成）
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // feature に自動生成コミット（"update: 1 files changed..."）があるはず
    let feature_log = run_git_output(&repo.repo, &["log", "feature", "--oneline"]);
    assert!(
        feature_log.contains("update:"),
        "feature に自動生成コミットメッセージがない: {feature_log}"
    );

    // main にはデフォルト merge コミット（-m 未指定のため）
    let main_log = run_git_output(&repo.repo, &["log", "main", "--oneline"]);
    assert!(
        main_log.contains("Merge branch 'feature'"),
        "main にデフォルト merge メッセージがない: {main_log}"
    );

    // リモートにも push されている
    let remote_log = run_git_output(&repo.bare, &["log", "main", "--oneline"]);
    assert!(
        remote_log.contains("Merge branch 'feature'"),
        "リモート main に push されていない: {remote_log}"
    );
}

#[test]
fn test_mt_git_sync_self_target_errors() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target")
        .arg("feature")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_ship_self_target_errors() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("feature")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_ship_works_when_target_checked_out_in_other_worktree_clean() {
    let repo = setup_test_repo();

    // feature branch を作成 & push
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    // main を別 worktree に追加（衝突する状態を作る）
    let main_wt = repo.tmp_path().join("main-wt");
    let main_wt_str = main_wt.to_str().unwrap();
    run_git(
        repo.tmp_path(),
        &[
            "-C",
            repo.repo.to_str().unwrap(),
            "worktree",
            "add",
            main_wt_str,
            "main",
        ],
    );

    // feature branch の作業ディレクトリから ship を実行
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .arg("--message")
        .arg("ship from worktree test")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // 別 worktree の main に feature の変更がマージされているはず
    let log = run_git_output(&main_wt, &["log", "--oneline"]);
    assert!(
        log.contains("feature commit"),
        "別 worktree の main に feature の変更がマージされていない: {log}"
    );
    assert!(
        log.contains("ship from worktree test"),
        "別 worktree の main に ship コミットが見つからない: {log}"
    );

    // リモート bare にも push されているはず
    let remote_log = run_git_output(&repo.bare, &["log", "--oneline", "main"]);
    assert!(
        remote_log.contains("feature commit"),
        "リモート main に feature の変更が push されていない: {remote_log}"
    );
}

#[test]
fn test_mt_git_ship_aborts_when_target_worktree_is_dirty() {
    let repo = setup_test_repo();

    // feature branch を作成 & push
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    // main を別 worktree に追加
    let main_wt = repo.tmp_path().join("main-wt");
    let main_wt_str = main_wt.to_str().unwrap();
    run_git(
        repo.tmp_path(),
        &[
            "-C",
            repo.repo.to_str().unwrap(),
            "worktree",
            "add",
            main_wt_str,
            "main",
        ],
    );

    // 別 worktree を dirty にする（未 commit の新規ファイル）
    std::fs::write(main_wt.join("dirty.txt"), "dirty\n").unwrap();

    // ship は失敗するはず
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .arg("--message")
        .arg("should fail")
        .current_dir(&repo.repo)
        .assert()
        .failure()
        .stderr(predicates::str::contains("未コミットの変更"));

    // main には feature の変更がマージされていないはず
    let log = run_git_output(&main_wt, &["log", "--oneline", "main"]);
    assert!(
        !log.contains("feature commit"),
        "dirty 状態なのに main に feature の変更がマージされてしまった: {log}"
    );
}

#[test]
fn test_mt_git_ship_target_default_uses_default_branch() {
    let repo = setup_test_repo();

    // origin/HEAD を main に設定（setup 後は既に main がデフォルト）
    run_git(&repo.repo, &["remote", "set-head", "origin", "main"]);

    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.repo.join("feature.txt"), "feature work\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    // --target-default で ship（target 省略時と同じ挙動を保証）
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target-default")
        .arg("--message")
        .arg("ship via --target-default")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // main に feature の変更がマージされているはず
    run_git(&repo.repo, &["checkout", "-q", "main"]);
    let log = run_git_output(&repo.repo, &["log", "--oneline"]);
    assert!(
        log.contains("feature commit"),
        "main に feature の変更がマージされていない: {log}"
    );
    assert!(
        log.contains("ship via --target-default"),
        "ship commit メッセージが見つからない: {log}"
    );
}

#[test]
fn test_mt_git_sync_target_default_uses_default_branch() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["remote", "set-head", "origin", "main"]);

    // feature branch を作成 & push
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);
    run_git(&repo.repo, &["push", "-u", "-q", "origin", "feature"]);

    // main に追加変更を push
    run_git(&repo.repo, &["checkout", "-q", "main"]);
    std::fs::write(repo.repo.join("main_update.txt"), "main update\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "main update"]);
    run_git(&repo.repo, &["push", "-q", "origin", "main"]);

    // feature に戻り、追加 commit を作成
    run_git(&repo.repo, &["checkout", "-q", "feature"]);
    std::fs::write(repo.repo.join("feature2.txt"), "feature work 2\n").unwrap();
    run_git(&repo.repo, &["add", "."]);
    run_git(&repo.repo, &["commit", "-qm", "feature commit 2"]);
    run_git(&repo.repo, &["push", "-q", "origin", "feature"]);

    // --target-default で sync
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target-default")
        .current_dir(&repo.repo)
        .assert()
        .success();

    // feature に main の変更が取り込まれているはず
    let log = run_git_output(&repo.repo, &["log", "--oneline"]);
    assert!(
        log.contains("main update"),
        "feature に main の変更が取り込まれていない: {log}"
    );
    assert!(
        repo.repo.join("main_update.txt").exists(),
        "main_update.txt が取り込まれていない"
    );
}

#[test]
fn test_mt_git_ship_target_and_target_default_conflict() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("ship")
        .arg("--target")
        .arg("main")
        .arg("--target-default")
        .arg("--message")
        .arg("should fail")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}

#[test]
fn test_mt_git_sync_target_and_target_default_conflict() {
    let repo = setup_test_repo();
    run_git(&repo.repo, &["checkout", "-q", "-b", "feature"]);

    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("git")
        .arg("sync")
        .arg("--target")
        .arg("main")
        .arg("--target-default")
        .current_dir(&repo.repo)
        .assert()
        .failure();
}
