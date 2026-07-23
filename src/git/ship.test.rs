use super::*;
use std::process::Command;

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

fn current_branch_of(cwd: &Path) -> String {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(["branch", "--show-current"])
        .output()
        .expect("git branch の取得に失敗");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// ---------------------------------------------------------------------------
// parse_status_lines: git status --porcelain の純粋解析（条件 1, 4）
// ---------------------------------------------------------------------------

#[test]
fn test_parse_status_lines_modified_staged() {
    let entries = parse_status_lines("M  README.md\n");
    assert_eq!(entries, vec![('M', "README.md".to_string())]);
}

#[test]
fn test_parse_status_lines_added_staged() {
    let entries = parse_status_lines("A  added.txt\n");
    assert_eq!(entries, vec![('A', "added.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_deleted_staged() {
    let entries = parse_status_lines("D  removed.txt\n");
    assert_eq!(entries, vec![('D', "removed.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_rename_takes_new_path() {
    // rename は「OLD -> NEW」の NEW 側を path とする
    let entries = parse_status_lines("R  README.md -> RENAMED.md\n");
    assert_eq!(entries, vec![('R', "RENAMED.md".to_string())]);
}

#[test]
fn test_parse_status_lines_untracked() {
    let entries = parse_status_lines("?? new.txt\n");
    assert_eq!(entries, vec![('?', "new.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_skips_short_lines() {
    // 4 文字未満の行（空行・1〜3 文字）はすべてスキップされる
    let entries = parse_status_lines("M  ok.txt\n?? \n\nA\n");
    assert_eq!(
        entries,
        vec![('M', "ok.txt".to_string())],
        "4 文字未満の行はスキップされるべき"
    );
}

#[test]
fn test_parse_status_lines_keeps_exactly_4_char_line() {
    // ちょうど 4 文字の行はスキップされない（境界値）
    let entries = parse_status_lines("?? a\n");
    assert_eq!(entries, vec![('?', "a".to_string())]);
}

#[test]
fn test_parse_status_lines_empty() {
    let entries = parse_status_lines("");
    assert!(entries.is_empty(), "空入力なら空");
}

// ---------------------------------------------------------------------------
// add_changed_files_in: 実 git リポジトリでのステージング挙動（条件 1, 4）
// ---------------------------------------------------------------------------

#[test]
fn test_add_changed_files_untracked_gets_added() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("new.txt"), "x\n").unwrap();

    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(
        added.contains(&"new.txt".to_string()),
        "untracked ファイルが add 対象に含まれるべき: {added:?}"
    );

    // git add 済み → staged 状態 (A) になっている
    let status = command_output_in(&path, "git", &["status", "--porcelain"])
        .expect("status 取得");
    assert!(
        status.contains("A  new.txt"),
        "add 後に staged 状態になるべき: {status:?}"
    );
}

#[test]
fn test_add_changed_files_staged_modified() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("README.md"), "changed\n").unwrap();
    run_git(&path, &["add", "README.md"]);

    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(
        added.contains(&"README.md".to_string()),
        "staged な変更 (M) が含まれるべき: {added:?}"
    );
}

#[test]
fn test_add_changed_files_staged_new_file() {
    let (_tmp, path) = make_temp_git_repo("main");
    std::fs::write(path.join("added.txt"), "a\n").unwrap();
    run_git(&path, &["add", "added.txt"]);

    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(
        added.contains(&"added.txt".to_string()),
        "staged な新規ファイル (A) が含まれるべき: {added:?}"
    );
}

#[test]
fn test_add_changed_files_staged_deletion() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["rm", "-q", "README.md"]);

    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(
        added.contains(&"README.md".to_string()),
        "staged な削除 (D) が含まれるべき: {added:?}"
    );
}

#[test]
fn test_add_changed_files_rename_uses_new_path() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["mv", "README.md", "RENAMED.md"]);

    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(
        added.contains(&"RENAMED.md".to_string()),
        "rename の NEW 側が含まれるべき: {added:?}"
    );
    assert!(
        !added.iter().any(|p| p.contains(" -> ")),
        "「 -> 」区切りの生文字列は含まれないべき: {added:?}"
    );
}

#[test]
fn test_add_changed_files_clean_repo_returns_empty() {
    let (_tmp, path) = make_temp_git_repo("main");
    let added = add_changed_files_in(&path).expect("add が成功するはず");
    assert!(added.is_empty(), "クリーンなリポジトリでは空であるべき: {added:?}");
}

// ---------------------------------------------------------------------------
// checkout_branch_in: 正常系・失敗系（条件 2, 4）
// ---------------------------------------------------------------------------

#[test]
fn test_checkout_branch_in_success() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    run_git(&path, &["checkout", "-q", "main"]);
    assert_eq!(current_branch_of(&path), "main");

    let ok = checkout_branch_in(&path, "feature", "main").expect("checkout が成功するはず");
    assert!(ok, "存在するブランチへの checkout は true を返すべき");
    assert_eq!(
        current_branch_of(&path),
        "feature",
        "feature ブランチに切り替わっているべき"
    );
}

#[test]
fn test_checkout_branch_in_failure_returns_err() {
    let (_tmp, path) = make_temp_git_repo("main");
    // 非 TTY のテスト環境では handle_failure 内の dialoguer::Select が Err を返すため、
    // checkout 失敗は bail（Err）として伝播する。
    let result = checkout_branch_in(&path, "no-such-branch", "main");
    assert!(
        result.is_err(),
        "存在しないブランチへの checkout は Err になるべき"
    );
    assert_eq!(
        current_branch_of(&path),
        "main",
        "checkout 失敗時はブランチが変わらないべき"
    );
}

// ---------------------------------------------------------------------------
// restore_original_branch_in: 正常系・失敗系（条件 2, 4）
// ---------------------------------------------------------------------------

#[test]
fn test_restore_original_branch_in_success() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    assert_eq!(current_branch_of(&path), "feature");

    restore_original_branch_in(&path, "main").expect("restore が成功するはず");
    assert_eq!(
        current_branch_of(&path),
        "main",
        "元のブランチ (main) に戻っているべき"
    );
}

#[test]
fn test_restore_original_branch_in_failure_is_graceful() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    assert_eq!(current_branch_of(&path), "feature");

    // 存在しないブランチへの checkout 失敗でも Ok を返し、ブランチは変わらない
    let result = restore_original_branch_in(&path, "no-such-branch");
    assert!(
        result.is_ok(),
        "restore は checkout 失敗でも Ok を返すべき（graceful）"
    );
    assert_eq!(
        current_branch_of(&path),
        "feature",
        "checkout 失敗時はブランチが変わらないべき"
    );
}
