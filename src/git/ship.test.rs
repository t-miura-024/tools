use super::*;
use crate::git::common::ActionSelector;

struct AbortSelector;
impl ActionSelector for AbortSelector {
    fn select(&self, _: &str, _: &[String]) -> anyhow::Result<usize> {
        Ok(0)
    }
}

struct FailSelector;
impl ActionSelector for FailSelector {
    fn select(&self, _: &str, _: &[String]) -> anyhow::Result<usize> {
        anyhow::bail!("対話入力ができないため、abort を選択しました")
    }
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = crate::test_support::git_command()
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
    let out = crate::test_support::git_command()
        .current_dir(cwd)
        .args(["branch", "--show-current"])
        .output()
        .expect("git branch の取得に失敗");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// ---------------------------------------------------------------------------
// parse_status_lines: git status --porcelain -z の純粋解析（NUL 区切り）
// ---------------------------------------------------------------------------

#[test]
fn test_parse_status_lines_modified_staged() {
    let entries = parse_status_lines("M  README.md\0");
    assert_eq!(entries, vec![('M', "README.md".to_string())]);
}

#[test]
fn test_parse_status_lines_added_staged() {
    let entries = parse_status_lines("A  added.txt\0");
    assert_eq!(entries, vec![('A', "added.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_deleted_staged() {
    let entries = parse_status_lines("D  removed.txt\0");
    assert_eq!(entries, vec![('D', "removed.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_rename_takes_new_path() {
    // -z では rename は `R  <new>\0<old>\0` の 2 フィールド、new 側のみを採用
    let entries = parse_status_lines("R  RENAMED.md\0README.md\0");
    assert_eq!(entries, vec![('R', "RENAMED.md".to_string())]);
}

#[test]
fn test_parse_status_lines_copy_takes_new_path() {
    let entries = parse_status_lines("C  copied.md\0original.md\0");
    assert_eq!(entries, vec![('C', "copied.md".to_string())]);
}

#[test]
fn test_parse_status_lines_untracked() {
    let entries = parse_status_lines("?? new.txt\0");
    assert_eq!(entries, vec![('?', "new.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_skips_short_lines() {
    // 3 文字未満および空エントリはスキップ（末尾 NUL による空文字列含む）
    let entries = parse_status_lines("M  ok.txt\0\0A\0\0");
    assert_eq!(
        entries,
        vec![('M', "ok.txt".to_string())],
        "3 文字未満や空エントリはスキップされるべき"
    );
}

#[test]
fn test_parse_status_lines_keeps_exactly_4_char_line() {
    // ちょうど 4 文字 (例: "?? a" -> len 4) はスキップされない（境界値）
    let entries = parse_status_lines("?? a\0");
    assert_eq!(entries, vec![('?', "a".to_string())]);
}

#[test]
fn test_parse_status_lines_empty() {
    let entries = parse_status_lines("");
    assert!(entries.is_empty(), "空入力なら空");
}

#[test]
fn test_parse_status_lines_trailing_nul_ignored() {
    // 末尾 NUL による空文字列は無視される
    let entries = parse_status_lines("M  a.txt\0");
    assert_eq!(entries, vec![('M', "a.txt".to_string())]);
    let entries2 = parse_status_lines("M  a.txt\0\0");
    assert_eq!(entries2, vec![('M', "a.txt".to_string())]);
}

#[test]
fn test_parse_status_lines_multiple_entries() {
    let entries = parse_status_lines("M  a.txt\0?? b.txt\0A  c.txt\0");
    assert_eq!(
        entries,
        vec![
            ('M', "a.txt".to_string()),
            ('?', "b.txt".to_string()),
            ('A', "c.txt".to_string()),
        ]
    );
}

#[test]
fn test_parse_status_lines_rename_followed_by_other() {
    // rename の old を消費した後、次のエントリが正しく解析される
    let entries = parse_status_lines("R  new.md\0old.md\0M  other.txt\0");
    assert_eq!(
        entries,
        vec![('R', "new.md".to_string()), ('M', "other.txt".to_string()),]
    );
}

#[test]
fn test_parse_status_lines_non_ascii() {
    // 非 ASCII パスは -z では quoting されず raw UTF-8 で来る
    let entries = parse_status_lines("?? docs/adr/0004-テスト.md\0");
    assert_eq!(entries, vec![('?', "docs/adr/0004-テスト.md".to_string())]);
}

#[test]
fn test_parse_status_lines_rename_non_ascii() {
    let entries =
        parse_status_lines("R  docs/adr/0004-テスト-new.md\0docs/adr/0004-テスト-old.md\0");
    assert_eq!(
        entries,
        vec![('R', "docs/adr/0004-テスト-new.md".to_string())]
    );
}

#[test]
fn test_parse_status_lines_arrow_in_path_not_split() {
    // 旧実装は " -> " で分割していたが、新実装では NUL 区切りのみ。path 内に " -> " が含まれても分割しない
    let entries = parse_status_lines("?? a -> b.txt\0");
    assert_eq!(entries, vec![('?', "a -> b.txt".to_string())]);
}

// ---------------------------------------------------------------------------
// add_changed_files_in: 実 git リポジトリでのステージング挙動
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
    let status = command_output_in(&path, "git", &["status", "--porcelain"]).expect("status 取得");
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
    assert!(
        added.is_empty(),
        "クリーンなリポジトリでは空であるべき: {added:?}"
    );
}

#[test]
fn test_add_changed_files_untracked_non_ascii() {
    let (_tmp, path) = make_temp_git_repo("main");
    // docs/adr が untracked ディレクトリのままだと `git status --porcelain -z` は
    // `?? docs/` のようにディレクトリ単位で出力されるため、個別ファイルとして
    // 検出させるためにダミーファイルを先に commit してディレクトリを tracked にする
    let dummy_rel = "docs/adr/README.md";
    let dummy_full = path.join(dummy_rel);
    std::fs::create_dir_all(dummy_full.parent().unwrap()).unwrap();
    std::fs::write(&dummy_full, "dummy\n").unwrap();
    run_git(&path, &["add", dummy_rel]);
    run_git(&path, &["commit", "-qm", "add dummy"]);

    let rel = "docs/adr/0004-テスト.md";
    let full = path.join(rel);
    std::fs::write(&full, "# テスト\n").unwrap();

    let added = add_changed_files_in(&path).expect("非 ASCII untracked の add が成功するはず");
    assert!(
        added.contains(&rel.to_string()),
        "非 ASCII untracked が add 対象に含まれるべき: {added:?}"
    );

    // staged 状態の確認は -z で NUL 区切りを考慮
    let status_z =
        command_output_in(&path, "git", &["status", "--porcelain", "-z"]).expect("status -z 取得");
    let entries = parse_status_lines(&status_z);
    assert!(
        entries.iter().any(|(_, p)| p == rel),
        "非 ASCII ファイルが staged 状態で検出されるべき: {entries:?}"
    );
}

#[test]
fn test_add_changed_files_modified_non_ascii() {
    let (_tmp, path) = make_temp_git_repo("main");
    let rel = "docs/adr/0004-テスト.md";
    let full = path.join(rel);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(&full, "initial\n").unwrap();
    run_git(&path, &["add", rel]);
    run_git(&path, &["commit", "-qm", "add non-ascii"]);

    // modified (unstaged) にする
    std::fs::write(&full, "modified\n").unwrap();

    let added = add_changed_files_in(&path).expect("非 ASCII modified の add が成功するはず");
    assert!(
        added.contains(&rel.to_string()),
        "非 ASCII modified が add 対象に含まれるべき: {added:?}"
    );

    let status_z =
        command_output_in(&path, "git", &["status", "--porcelain", "-z"]).expect("status -z 取得");
    let entries = parse_status_lines(&status_z);
    // add 後は staged (M) として記録される
    assert!(
        entries.iter().any(|(c, p)| p == rel && *c == 'M'),
        "非 ASCII modified が staged (M) になるべき: {entries:?}"
    );
}

// ---------------------------------------------------------------------------
// checkout_branch_in: 正常系・失敗系
// ---------------------------------------------------------------------------

#[test]
fn test_checkout_branch_in_success() {
    let (_tmp, path) = make_temp_git_repo("main");
    run_git(&path, &["checkout", "-q", "-b", "feature"]);
    run_git(&path, &["checkout", "-q", "main"]);
    assert_eq!(current_branch_of(&path), "main");

    let ok = checkout_branch_in(&path, "feature", "main", &AbortSelector)
        .expect("checkout が成功するはず");
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
    let result = checkout_branch_in(&path, "no-such-branch", "main", &FailSelector);
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
// restore_original_branch_in: 正常系・失敗系
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
