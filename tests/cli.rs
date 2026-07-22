use assert_cmd::Command;
use predicates::prelude::predicate;

#[test]
fn test_mt_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("個人用 CLI ツール群"));
}

#[test]
fn test_mt_git_repo_create_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "repo", "create", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("GitHub リポジトリ"));
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
        .stdout(predicate::str::contains("Git worktree と新規ブランチを対話的に作成"));
}

#[test]
fn test_mt_git_worktree_delete_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "worktree", "delete", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Git worktree を対話的に削除"));
}

#[test]
fn test_mt_git_sync_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "sync", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "現在のブランチを upstream と同期",
        ));
}

#[test]
fn test_mt_git_ship_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["git", "ship", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("ステージ・コミット・プッシュ"));
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
        .stdout(predicate::str::contains("ngrok セッション"));
}

#[test]
fn test_mt_tool_install_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("マニフェスト"));
}

#[test]
fn test_mt_tool_verify_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "verify", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Homebrew / mise"));
}

#[test]
fn test_mt_tool_brew_upgrade_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "brew", "upgrade", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Homebrew パッケージ"));
}

#[test]
fn test_mt_self_install_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["self", "install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("ビルド"));
}

#[test]
fn test_mt_plan_draft_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["plan", "draft", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("draft で作成"));
}
