use super::*;

#[test]
fn test_format_recovery_hints_contains_key_commands() {
    let path = Path::new("/Users/mt/src/tools-wt-1");
    let hints = format_recovery_hints(path);

    assert!(hints.contains("git worktree prune"));
    assert!(hints.contains("git reflog"));
    assert!(hints.contains("tools-wt-1"));
    assert!(hints.contains("git checkout"));
}

#[test]
fn test_format_recovery_hints_falls_back_to_generic_name() {
    let path = Path::new("/");
    let hints = format_recovery_hints(path);

    // ファイル名が取れないパスでも "worktree" のフォールバックが含まれる
    assert!(hints.contains("worktree"));
}

// 実 git を一時ディレクトリに作って check_worktree_safety を検証
// テスト並列実行で CWD が他テストと衝突しないよう、check_worktree_safety は
// パス引数で動作するため、ここで cd は使わない。

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
fn test_check_worktree_safety_clean() {
    let (_tmp, path) = make_temp_git_repo("main");
    let issues = check_worktree_safety(&path).unwrap();
    assert!(
        issues.is_empty(),
        "クリーンな wt には issue がないはず: {issues:?}"
    );
}

#[test]
fn test_check_worktree_safety_dirty() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("uncommitted.txt"), "dirty\n").unwrap();

    let issues = check_worktree_safety(&path).unwrap();
    assert!(
        issues
            .iter()
            .any(|i| matches!(i.kind, SafetyKind::Uncommitted)),
        "未コミット変更が検出されるはず: {issues:?}"
    );
}

#[test]
fn test_check_worktree_safety_unpushed() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(path.join("feature.txt"), "f\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "feature commit"]);
    // main を upstream として設定（push はしない）
    run_git(&path, &["branch", "--set-upstream-to=main", "feature"]);

    let issues = check_worktree_safety(&path).unwrap();
    assert!(
        issues
            .iter()
            .any(|i| matches!(i.kind, SafetyKind::Unpushed)),
        "未 push commit が検出されるはず: {issues:?}"
    );
}

#[test]
fn test_check_worktree_safety_unmerged() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(path.join("feature.txt"), "f\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "feature commit"]);
    // main に戻って別の変更を入れる（マージはしない）
    run_git(&path, &["checkout", "-q", "main"]);
    std::fs::write(path.join("other.txt"), "o\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "main change"]);

    // feature wt のパスを指定して安全検査
    let issues = check_worktree_safety(&path).unwrap();
    // ここでは main 自体が base に該当する branch なので、unmerged には挙がらない想定
    assert!(
        !issues
            .iter()
            .any(|i| matches!(i.kind, SafetyKind::Unmerged)),
        "main 自体は unmerged 扱いされないはず: {issues:?}"
    );
}
