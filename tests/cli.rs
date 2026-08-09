mod support;
use predicates::prelude::predicate;
use support::Command;

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
        .stdout(predicate::str::contains(
            "Git worktree と新規ブランチを対話的に作成",
        ));
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
        .stdout(predicate::str::contains("現在のブランチを upstream と同期"));
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
fn test_mt_tool_bun_upgrade_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["tool", "bun", "upgrade", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("bun global パッケージ"));
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

#[test]
fn test_mt_plan_draft_help_non_interactive_args() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["plan", "draft", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--title"))
        .stdout(predicate::str::contains("--body-file"))
        .stdout(predicate::str::contains("--repo"));
}

#[test]
fn test_mt_plan_draft_partial_args_title_only() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["plan", "draft", "--title", "some title"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "--title, --body-file, --repo を同時に指定",
        ))
        .stderr(predicate::str::contains("--body-file"))
        .stderr(predicate::str::contains("--repo"));
}

#[test]
fn test_mt_plan_draft_partial_args_missing_repo() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args([
        "plan",
        "draft",
        "--title",
        "t",
        "--body-file",
        "/tmp/body.md",
    ])
    .assert()
    .failure()
    .stderr(predicate::str::contains("--repo"));
}

#[test]
fn test_mt_plan_draft_partial_args_missing_title_and_body_file() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["plan", "draft", "--repo", "/tmp"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("--title"))
        .stderr(predicate::str::contains("--body-file"));
}

#[test]
fn test_mt_plan_draft_missing_body_file() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args([
        "plan",
        "draft",
        "--title",
        "t",
        "--body-file",
        "/nonexistent/mt-plan-draft-body.md",
        "--repo",
        "/tmp",
    ])
    .assert()
    .failure()
    .stderr(predicate::str::contains("body ファイルが見つかりません"));
}

#[test]
fn test_mt_doctor_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.arg("doctor")
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("健全性"));
}
