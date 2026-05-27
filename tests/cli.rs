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
fn test_mt_init_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["init", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("cargo/bin"));
}
