use super::*;
use crate::git::common::ActionSelector;
use std::path::PathBuf;
use std::process::Command;

struct AbortSelector;
impl ActionSelector for AbortSelector {
    fn select(&self, _: &str, _: &[String]) -> anyhow::Result<usize> {
        Ok(0)
    }
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
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

// --- ガード条件: protected branch で bail ---

#[test]
fn test_sync_in_bails_on_protected_branch_main() {
    let (_tmp, path) = make_temp_git_repo("main");
    let result = sync_in(&path, Some("feature".to_string()), false, &AbortSelector);
    assert!(result.is_err(), "main ブランチでは sync すべきでない");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("デフォルトブランチ"),
        "protected branch ガードのメッセージが含まれるべき: {err}"
    );
}

#[test]
fn test_sync_in_bails_on_protected_branch_master() {
    let (_tmp, path) = make_temp_git_repo("master");
    let result = sync_in(&path, Some("feature".to_string()), false, &AbortSelector);
    assert!(result.is_err(), "master ブランチでは sync すべきでない");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("デフォルトブランチ"),
        "protected branch ガードのメッセージが含まれるべき: {err}"
    );
}

// --- ガード条件: target == current で bail ---

#[test]
fn test_sync_in_bails_when_target_equals_current() {
    let (_tmp, path) = make_temp_git_repo("feature");
    let result = sync_in(&path, Some("feature".to_string()), false, &AbortSelector);
    assert!(result.is_err(), "target == current では sync すべきでない");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("現在のブランチと同じ"),
        "target == current ガードのメッセージが含まれるべき: {err}"
    );
}

#[test]
fn test_sync_in_bails_when_target_default_resolves_to_current() {
    // origin/HEAD が current ブランチを指す場合、target_default で target == current になる
    let (_tmp, path) = make_temp_git_repo("develop");
    run_git(
        &path,
        &["remote", "add", "origin", "/tmp/nonexistent-sync-test.git"],
    );
    run_git(
        &path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/heads/develop",
        ],
    );

    let result = sync_in(&path, None, true, &AbortSelector);
    assert!(
        result.is_err(),
        "target_default が current と同じブランチを返す場合は bail すべき"
    );
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("現在のブランチと同じ"),
        "target == current ガードのメッセージが含まれるべき: {err}"
    );
}

// --- 正常系: ガードを通過することの確認 ---

#[test]
fn test_sync_in_passes_guards_on_feature_branch_with_different_target() {
    // feature ブランチで target が異なる場合、ガードを通過して fetch に進む
    // (remote がないため fetch で失敗するが、ガードエラーではない)
    let (_tmp, path) = make_temp_git_repo("feature");
    let result = sync_in(&path, Some("main".to_string()), false, &AbortSelector);
    // fetch 失敗 → handle_failure_in → AbortSelector が abort (0) を返す → Ok(())
    // いずれにせよ、ガード条件の bail メッセージではないことを確認
    if let Err(e) = &result {
        let msg = e.to_string();
        assert!(
            !msg.contains("デフォルトブランチ"),
            "feature ブランチでは protected branch ガードに引っかからない: {msg}"
        );
        assert!(
            !msg.contains("現在のブランチと同じ"),
            "target != current では same-branch ガードに引っかからない: {msg}"
        );
    }
    // Ok(()) の場合はガード通過後に fetch 失敗 → handle_failure → abort で正常終了
}
