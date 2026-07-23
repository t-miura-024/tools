use super::*;

#[test]
fn test_parse_worktree_porcelain() {
    let output = "\
worktree /repo/main
HEAD abcdef1234567890
branch refs/heads/main

worktree /repo/feature
HEAD 1234567890abcdef
branch refs/heads/feature/foo

worktree /repo/detached
HEAD fedcba9876543210
detached
";

    let entries = parse_worktree_porcelain(output);

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "/repo/main");
    assert_eq!(entries[0].label(), "[main]");
    assert_eq!(entries[1].label(), "[feature/foo]");
    assert_eq!(entries[2].label(), "(fedcba9)");
}

#[test]
fn test_parse_shortstat_empty() {
    assert_eq!(parse_shortstat(""), "+0 -0");
    assert_eq!(parse_shortstat("   \n  "), "+0 -0");
}

#[test]
fn test_parse_shortstat_insertions_and_deletions() {
    assert_eq!(
        parse_shortstat(" 2 files changed, 12 insertions(+), 7 deletions(-)"),
        "+12 -7"
    );
}

#[test]
fn test_parse_shortstat_singular_file() {
    assert_eq!(
        parse_shortstat(" 1 file changed, 3 insertions(+), 1 deletion(-)"),
        "+3 -1"
    );
}

#[test]
fn test_parse_shortstat_insertions_only() {
    assert_eq!(parse_shortstat(" 1 file changed, 5 insertions(+)"), "+5 -0");
}

#[test]
fn test_parse_shortstat_deletions_only() {
    assert_eq!(parse_shortstat(" 1 file changed, 2 deletions(-)"), "+0 -2");
}

#[test]
fn test_parse_shortstat_zero_diff_falls_back_to_zero_zero() {
    // 想定外フォーマット: 数字が取れなければ +0 -0 にフォールバック
    assert_eq!(parse_shortstat(" something weird "), "+0 -0");
}

// 実 git を一時ディレクトリに作って collect_shortstat を検証。
// テスト並列実行で CWD が他テストと衝突しないよう、パス引数で動作させる。

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
fn test_collect_shortstat_populates_entries() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("new.txt"), "hello\nworld\n").unwrap();
    std::fs::write(path.join("README.md"), "changed\n").unwrap();

    let mut entries = vec![WorktreeEntry {
        path: path.to_string_lossy().to_string(),
        head: None,
        branch: Some("main".to_string()),
        is_bare: false,
        is_detached: false,
        shortstat: String::new(),
    }];

    collect_shortstat(&mut entries);

    assert!(
        !entries[0].shortstat.is_empty(),
        "変更がある wt では shortstat がセットされるはず"
    );
    assert!(
        entries[0].shortstat.starts_with('+'),
        "shortstat は +N -M 形式であるはず: {:?}",
        entries[0].shortstat
    );
}

#[test]
fn test_collect_shortstat_skips_bare() {
    let mut entries = vec![WorktreeEntry {
        path: "/nonexistent".to_string(),
        head: None,
        branch: None,
        is_bare: true,
        is_detached: false,
        shortstat: "+0 -0".to_string(),
    }];

    collect_shortstat(&mut entries);

    assert_eq!(entries[0].shortstat, "+0 -0", "bare は shortstat 対象外");
}
