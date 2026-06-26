use assert_cmd::Command;
use predicates::prelude::predicate;

#[test]
fn test_mt_chezmoi_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("dotfile management"));
}

#[test]
fn test_mt_chezmoi_apply_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "apply", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_diff_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "diff", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_status_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "status", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_init_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "init", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_doctor_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "doctor", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("chezmoi doctor"));
}

#[test]
fn test_mt_chezmoi_add_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "add", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_edit_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "edit", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_install_hook_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "install-hook", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_chezmoi_uninstall_hook_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["chezmoi", "uninstall-hook", "--help"])
        .assert()
        .success();
}

#[test]
fn test_mt_self_install_help_mentions_chezmoi() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["self", "install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("chezmoi"));
}
