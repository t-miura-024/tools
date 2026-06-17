use super::*;
use std::path::PathBuf;
use std::process::{Command, Command as StdCommand};

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

#[test]
fn test_is_protected_branch_main() {
    assert!(is_protected_branch("main"));
}

#[test]
fn test_is_protected_branch_master() {
    assert!(is_protected_branch("master"));
}

#[test]
fn test_is_protected_branch_feature() {
    assert!(!is_protected_branch("feature/foo"));
    assert!(!is_protected_branch("develop"));
    assert!(!is_protected_branch("HEAD"));
}

#[test]
fn test_format_branches_for_fzf_default_first() {
    let branches = vec![
        "feature/foo".to_string(),
        "main".to_string(),
        "develop".to_string(),
        "feature/bar".to_string(),
    ];
    let formatted = format_branches_for_fzf(&branches, "main");
    let lines: Vec<&str> = formatted.lines().collect();
    assert_eq!(lines[0], "main", "デフォルトブランチが先頭に来るべき");
    assert_eq!(lines.len(), 4);
}

#[test]
fn test_format_branches_for_fzf_default_missing() {
    let branches = vec![
        "feature/foo".to_string(),
        "develop".to_string(),
        "feature/bar".to_string(),
    ];
    let formatted = format_branches_for_fzf(&branches, "main");
    let lines: Vec<&str> = formatted.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(!lines.contains(&"main"));
}

#[test]
fn test_format_branches_for_fzf_alpha_order_for_non_default() {
    let branches = vec![
        "zeta".to_string(),
        "alpha".to_string(),
        "main".to_string(),
        "mu".to_string(),
    ];
    let formatted = format_branches_for_fzf(&branches, "main");
    let lines: Vec<&str> = formatted.lines().collect();
    assert_eq!(lines[0], "main");
    assert_eq!(lines[1], "alpha");
    assert_eq!(lines[2], "mu");
    assert_eq!(lines[3], "zeta");
}

#[test]
fn test_generate_commit_message_empty() {
    assert_eq!(generate_commit_message(""), "update: workspace changes");
}

#[test]
fn test_generate_commit_message_with_insertions_and_deletions() {
    let shortstat = " 2 files changed, 12 insertions(+), 7 deletions(-)";
    let message = generate_commit_message(shortstat);
    assert!(message.contains("update:"));
    assert!(message.contains("2"));
    assert!(message.contains("12"));
    assert!(message.contains("7"));
}

#[test]
fn test_generate_commit_message_single_file() {
    let shortstat = " 1 file changed, 3 insertions(+), 1 deletion(-)";
    let message = generate_commit_message(shortstat);
    assert!(message.contains("update:"));
    assert!(message.contains("1 file"));
    assert!(message.contains("3"));
    assert!(message.contains("1"));
}

#[test]
fn test_generate_commit_message_insertions_only() {
    let shortstat = " 1 file changed, 5 insertions(+)";
    let message = generate_commit_message(shortstat);
    assert!(message.contains("update:"));
    assert!(message.contains("5"));
    assert!(message.contains("0"));
}

#[test]
fn test_resolve_default_branch_main_exists() {
    let (_tmp, path) = make_temp_git_repo("main");
    let branch = resolve_default_branch_in(&path).expect("main を検出できるはず");
    assert_eq!(branch, "main");
}

#[test]
fn test_resolve_default_branch_master_exists() {
    let (_tmp, path) = make_temp_git_repo("master");
    let branch = resolve_default_branch_in(&path).expect("master を検出できるはず");
    assert_eq!(branch, "master");
}

#[test]
fn test_resolve_default_branch_origin_head_fallback() {
    let (_tmp, path) = make_temp_git_repo("develop");
    run_git(
        &path,
        &[
            "remote",
            "add",
            "origin",
            "/tmp/nonexistent-mt-default-branch-test.git",
        ],
    );
    run_git(
        &path,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/develop"],
    );
    let branch = resolve_default_branch_in(&path).expect("origin/HEAD を検出できるはず");
    assert_eq!(branch, "develop");
}

#[test]
fn test_resolve_default_branch_strips_origin_prefix() {
    // git symbolic-ref --short は環境によって "origin/main" を返すことがある
    // （refs/remotes/ は除かれるが origin/ は残る）。実装側で除去する必要がある。
    // bare リポジトリで origin/HEAD を手動設定し、ローカル clone を作成して検証する。
    let tmp = tempfile::tempdir().expect("tempdir");
    let bare = tmp.path().join("bare.git");
    run_git(
        tmp.path(),
        &["init", "--bare", "-q", "-b", "main", bare.to_str().unwrap()],
    );

    let clone = tmp.path().join("clone");
    run_git(tmp.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
    run_git(&clone, &["config", "user.email", "test@test.local"]);
    run_git(&clone, &["config", "user.name", "test"]);
    // origin/HEAD を手動設定（remote show で確認可能な状態にする）
    run_git(
        &clone,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main"],
    );

    // origin/HEAD が clone 時に設定されているはず
    let symbolic = StdCommand::new("git")
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .current_dir(&clone)
        .output()
        .expect("git");
    let symbolic_stdout = String::from_utf8_lossy(&symbolic.stdout)
        .trim_end()
        .to_string();
    // git のバージョンによって出力が "origin/main" か "main" か異なる
    // 実装はどちらでも純粋なブランチ名 ("main") を返すべき
    let branch = resolve_default_branch_in(&clone).expect("origin/HEAD を検出できるはず");
    assert_eq!(
        branch, "main",
        "symbolic-ref の出力が {symbolic_stdout:?} でも純粋なブランチ名を返すべき"
    );
}

#[test]
fn test_resolve_default_branch_failure() {
    let (_tmp, path) = make_temp_git_repo("weird");
    let result = resolve_default_branch_in(&path);
    assert!(
        result.is_err(),
        "デフォルトブランチが検出できない場合はエラー"
    );
}

#[test]
fn test_local_branches_lists_all() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature-a"]);
    run_git(&path, &["checkout", "-q", "-b", "feature-b"]);
    run_git(&path, &["checkout", "-q", "main"]);

    let branches = local_branches_in(&path).expect("ブランチ一覧取得");
    assert_eq!(branches.len(), 3);
    assert!(branches.contains(&"main".to_string()));
    assert!(branches.contains(&"feature-a".to_string()));
    assert!(branches.contains(&"feature-b".to_string()));
}

#[test]
fn test_current_branch_in_repo() {
    let (_tmp, path) = make_temp_git_repo("main");
    let branch = current_branch_in(&path).expect("現在のブランチ取得");
    assert_eq!(branch, "main");
}

#[test]
fn test_snapshot_git_state_clean() {
    let (_tmp, path) = make_temp_git_repo("main");
    let snapshot = snapshot_git_state_in(&path);
    assert!(snapshot.contains("現在のブランチ:"));
    assert!(snapshot.contains("main"));
    assert!(snapshot.contains("クリーン"));
}

#[test]
fn test_snapshot_git_state_dirty() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("dirty.txt"), "x").unwrap();
    let snapshot = snapshot_git_state_in(&path);
    assert!(snapshot.contains("dirty.txt") || snapshot.contains("未コミット変更"));
}

#[test]
fn test_ensure_fzf_present_returns_bool() {
    // bool が返ることを確認（fzf の有無は環境依存）
    let _ = ensure_fzf_present();
}
