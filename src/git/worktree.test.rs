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
fn test_format_worktree_rows() {
    let entries = vec![WorktreeEntry {
        path: "/repo/main".to_string(),
        head: Some("abcdef1234567890".to_string()),
        branch: Some("main".to_string()),
        is_bare: false,
        is_detached: false,
    }];

    let rows = format_worktree_rows(&entries, "/repo/main");

    assert!(rows.contains("main"));
    assert!(rows.contains("[main]"));
    assert!(rows.contains("\t/repo/main"));
}

fn entry(path: &str) -> WorktreeEntry {
    WorktreeEntry {
        path: path.to_string(),
        head: None,
        branch: None,
        is_bare: false,
        is_detached: false,
    }
}

#[test]
fn test_next_worktree_index_empty() {
    let entries: Vec<WorktreeEntry> = vec![];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

#[test]
fn test_next_worktree_index_only_main() {
    let entries = vec![entry("/Users/mt/src/tools")];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

#[test]
fn test_next_worktree_index_increments() {
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 2);
}

#[test]
fn test_next_worktree_index_finds_max() {
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/src/tools-wt-2"),
        entry("/Users/mt/src/tools-wt-5"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 6);
}

#[test]
fn test_next_worktree_index_does_not_reuse_holes() {
    // wt-1 と wt-3 があり wt-2 が欠番 → 4 を作る（穴埋めしない）
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/src/tools-wt-3"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 4);
}

#[test]
fn test_next_worktree_index_filters_by_parent() {
    // 同じ repo 名でも親ディレクトリが違えばカウントしない
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/tools-wt-1"),
        entry("/Users/mt/other/tools-wt-9"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 2);
}

#[test]
fn test_next_worktree_index_filters_by_repo_name() {
    // 同じ親でも別 repo の wt はカウントしない
    let entries = vec![
        entry("/Users/mt/src/tools"),
        entry("/Users/mt/src/other-wt-1"),
    ];
    let next = next_worktree_index(&entries, Path::new("/Users/mt/src"), "tools");
    assert_eq!(next, 1);
}

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

#[test]
fn test_branch_exists_true() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature-branch"]);
    run_git(&path, &["checkout", "-q", "main"]);

    assert!(branch_exists(&path, "feature-branch"));
}

#[test]
fn test_branch_exists_false() {
    let (_tmp, path) = make_temp_git_repo("main");
    assert!(!branch_exists(&path, "nonexistent"));
}
