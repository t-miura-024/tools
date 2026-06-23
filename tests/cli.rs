use assert_cmd::Command;
use predicates::prelude::predicate;

#[test]
fn test_mt_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Personal CLI tools"));
}

#[test]
fn test_mt_git_repo_create_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "repo", "create", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("GitHub repository"));
}

#[test]
fn test_mt_git_worktree_select_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "worktree", "select", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Git worktree"));
}

#[test]
fn test_mt_git_worktree_create_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "worktree", "create", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Create a new Git worktree"));
}

#[test]
fn test_mt_git_worktree_delete_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "worktree", "delete", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Delete a Git worktree"));
}

#[test]
fn test_mt_git_sync_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "sync", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Sync current branch with upstream",
        ));
}

#[test]
fn test_mt_git_ship_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "ship", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Stage, commit, push, and merge"));
}

#[test]
fn test_mt_opencode_oauth_setup_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["opencode", "oauth", "setup", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Google OAuth"));
}

#[test]
fn test_mt_opencode_web_expose_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["opencode", "web", "expose", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("OpenCode Web"));
}

#[test]
fn test_mt_opencode_web_stop_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["opencode", "web", "stop", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("ngrok session"));
}

#[test]
fn test_mt_tool_install_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("repository manifests"));
}

#[test]
fn test_mt_tool_verify_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "verify", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Homebrew and mise"));
}

#[test]
fn test_mt_tool_brew_upgrade_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "brew", "upgrade", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Homebrew packages"));
}

#[test]
fn test_mt_self_install_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["self", "install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("cargo install"));
}
