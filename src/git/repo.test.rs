use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use super::*;

#[test]
fn test_repo_name_validation() {
    let valid_names = ["my-repo", "my.repo", "my_repo", "repo123", "a.b-c_d"];
    for name in &valid_names {
        assert!(
            name.chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
            "{} should be valid",
            name
        );
    }

    let invalid_names = ["my repo", "repo/name", "repo!name"];
    for name in &invalid_names {
        assert!(
            !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
            "{} should be invalid",
            name
        );
    }
}

#[test]
fn test_parse_git_pointer() {
    let content = "gitdir: /Users/mt/doc/note/.git/worktrees/note-wt-1\n";
    assert_eq!(
        parse_git_pointer(content),
        Some("/Users/mt/doc/note/.git/worktrees/note-wt-1".to_string())
    );
}

#[test]
fn test_parse_git_pointer_invalid() {
    assert_eq!(parse_git_pointer(""), None);
    assert_eq!(parse_git_pointer("not a gitdir line"), None);
    // 値が無い壊れたファイルは None 扱い
    assert_eq!(parse_git_pointer("gitdir:\n"), None);
}

#[test]
fn test_repo_entry_label() {
    let branch = RepoEntry {
        category: "doc".to_string(),
        name: "note".to_string(),
        path: PathBuf::from("/tmp/doc/note"),
        group: "note".to_string(),
        is_worktree: false,
        head_info: HeadInfo::Branch("main".to_string()),
    };
    assert_eq!(branch.label(), "[main]");

    let detached = RepoEntry {
        head_info: HeadInfo::Detached("abcdef1".to_string()),
        ..branch_clone(&branch)
    };
    assert_eq!(detached.label(), "(abcdef1)");

    let bare = RepoEntry {
        head_info: HeadInfo::Bare,
        ..branch_clone(&branch)
    };
    assert_eq!(bare.label(), "(bare)");

    let unknown = RepoEntry {
        head_info: HeadInfo::Unknown,
        ..branch_clone(&branch)
    };
    assert_eq!(unknown.label(), "(?)");
}

fn branch_clone(entry: &RepoEntry) -> RepoEntry {
    RepoEntry {
        category: entry.category.clone(),
        name: entry.name.clone(),
        path: entry.path.clone(),
        group: entry.group.clone(),
        is_worktree: entry.is_worktree,
        head_info: HeadInfo::Branch("main".to_string()),
    }
}

#[test]
fn test_group_and_sort_order() {
    let entries = vec![
        entry("src", "tools", "tools", false),
        entry("doc", "note-wt-1", "note", true),
        entry("doc", "note", "note", false),
        entry("doc", "paleo-blog", "paleo-blog", false),
    ];
    let sorted = group_and_sort(entries);

    // doc カテゴリ内では note グループ → paleo-blog グループの順
    assert_eq!(sorted[0].name, "note");
    assert!(!sorted[0].is_worktree);
    assert_eq!(sorted[1].name, "note-wt-1");
    assert!(sorted[1].is_worktree);
    assert_eq!(sorted[2].name, "paleo-blog");
    assert_eq!(sorted[3].name, "tools");
    assert_eq!(sorted[3].category, "src");
}

#[test]
fn test_group_and_sort_keeps_isolated_worktree_group() {
    // 親が探索範囲外にある worktree は独立グループとして残す
    let entries = vec![
        entry("doc", "foo-wt", "foo", true),
        entry("doc", "note", "note", false),
    ];
    let sorted = group_and_sort(entries);

    // グループ名 foo が paleo-blog / note とは独立している
    assert_eq!(sorted[0].group, "foo");
    assert_eq!(sorted[1].group, "note");
}

fn entry(category: &str, name: &str, group: &str, is_worktree: bool) -> RepoEntry {
    RepoEntry {
        category: category.to_string(),
        name: name.to_string(),
        path: PathBuf::from(format!("/tmp/{category}/{name}")),
        group: group.to_string(),
        is_worktree,
        head_info: HeadInfo::Branch("main".to_string()),
    }
}

#[test]
fn test_format_repo_rows_padded_columns() {
    let entries = vec![
        entry("doc", "note", "note", false),
        entry("doc", "note-wt-1", "note", true),
    ];
    let rows = format_repo_rows(&entries);

    // ヘッダー行: 4 カラムが 2 スペース区切りで左寄せパディングされている
    // note-wt-1 が 9 文字なので worktree カラムは 9 幅にパディングされる
    let header_line = rows.lines().next().unwrap();
    assert!(
        header_line.starts_with("category  group  worktree   branch"),
        "ヘッダー行のフォーマット: {header_line:?}"
    );

    // 本体: worktree カラムは空、padded 後に \t + パス
    let body_line = rows
        .lines()
        .find(|l| l.contains("/tmp/doc/note\n") || l.ends_with("/tmp/doc/note"))
        .expect("本体行が含まれる");
    assert!(
        body_line.starts_with("doc       note              [main]"),
        "本体行の左寄せパディング: {body_line:?}"
    );
    assert!(
        body_line.contains("[main]\t/tmp/doc/note"),
        "本体行の末尾はタブ区切りでパス: {body_line:?}"
    );

    // worktree 行
    let wt_line = rows
        .lines()
        .find(|l| l.contains("note-wt-1"))
        .expect("worktree 行が含まれる");
    assert!(
        wt_line.starts_with("doc       note   note-wt-1  [main]"),
        "worktree 行の左寄せパディング: {wt_line:?}"
    );
    assert!(
        wt_line.contains("[main]\t/tmp/doc/note-wt-1"),
        "worktree 行の末尾はタブ区切りでパス: {wt_line:?}"
    );
}

#[test]
fn test_parse_repo_selection() {
    let line = "doc       note   note-wt-1  [main]	/Users/mt/doc/note-wt-1";
    let path = parse_repo_selection(line).unwrap();
    assert_eq!(path, "/Users/mt/doc/note-wt-1");
}

#[test]
fn test_parse_repo_selection_invalid() {
    assert!(parse_repo_selection("not a tab separated line").is_err());
    assert!(parse_repo_selection("").is_err());
}

// tempfile を使った統合テスト: 実ディレクトリと .git 構造を作って discover_repos を検証

struct Fixture {
    _tmp: TempDir,
    doc: PathBuf,
    src: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let doc = tmp.path().join("doc");
        let src = tmp.path().join("src");
        fs::create_dir_all(&doc).unwrap();
        fs::create_dir_all(&src).unwrap();
        Self {
            _tmp: tmp,
            doc,
            src,
        }
    }

    fn make_main_repo(&self, category: &str, name: &str, branch: &str) -> PathBuf {
        let root = if category == "doc" {
            &self.doc
        } else {
            &self.src
        };
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        let git = path.join(".git");
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        path
    }

    fn make_worktree(
        &self,
        category: &str,
        worktree_name: &str,
        main_repo_path: &std::path::Path,
        branch: &str,
    ) -> PathBuf {
        let root = if category == "doc" {
            &self.doc
        } else {
            &self.src
        };
        let path = root.join(worktree_name);
        fs::create_dir_all(&path).unwrap();
        let worktree_git = main_repo_path.join(".git/worktrees").join(worktree_name);
        fs::create_dir_all(&worktree_git).unwrap();
        fs::write(
            path.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()),
        )
        .unwrap();
        fs::write(
            worktree_git.join("HEAD"),
            format!("ref: refs/heads/{branch}\n"),
        )
        .unwrap();
        path
    }
}

#[test]
fn test_discover_repos_finds_main_and_worktree() {
    let fx = Fixture::new();
    let main = fx.make_main_repo("doc", "note", "main");
    fx.make_worktree("doc", "note-wt-1", &main, "topic/a");
    fx.make_main_repo("doc", "paleo-blog", "main");
    fx.make_main_repo("src", "tools", "main");

    let roots = vec![fx.doc.clone(), fx.src.clone()];
    let mut entries = discover_repos(&roots).unwrap();
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    assert_eq!(entries.len(), 4);

    let note = entries.iter().find(|e| e.name == "note").unwrap();
    assert_eq!(note.group, "note");
    assert!(!note.is_worktree);
    assert!(matches!(note.head_info, HeadInfo::Branch(ref b) if b == "main"));

    let wt = entries.iter().find(|e| e.name == "note-wt-1").unwrap();
    assert_eq!(wt.group, "note");
    assert!(wt.is_worktree);
    assert!(matches!(wt.head_info, HeadInfo::Branch(ref b) if b == "topic/a"));
}

#[test]
fn test_discover_repos_skips_non_git_dirs() {
    let fx = Fixture::new();
    fx.make_main_repo("doc", "note", "main");
    // .git を持たないディレクトリ
    fs::create_dir_all(fx.doc.join("not-a-repo")).unwrap();
    // ファイル
    fs::write(fx.doc.join("stray.txt"), "hello").unwrap();

    let roots = vec![fx.doc.clone(), fx.src.clone()];
    let entries = discover_repos(&roots).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "note");
}

#[test]
fn test_discover_repos_handles_missing_roots() {
    let fx = Fixture::new();
    // doc だけ実在、src は作らない
    fx.make_main_repo("doc", "note", "main");

    let roots = vec![fx.doc.clone(), fx.src.clone()];
    let entries = discover_repos(&roots).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "note");
}

#[test]
fn test_discover_repos_keeps_isolated_worktree_group() {
    let fx = Fixture::new();
    // 親が探索範囲外（fx._tmp 配下でもない）の worktree
    let worktree_path = fx.doc.join("foo-wt");
    fs::create_dir_all(&worktree_path).unwrap();
    let external_git = fx._tmp.path().join("external/.git/worktrees/foo-wt");
    fs::create_dir_all(&external_git).unwrap();
    fs::write(
        worktree_path.join(".git"),
        format!("gitdir: {}\n", external_git.display()),
    )
    .unwrap();
    fs::write(external_git.join("HEAD"), "ref: refs/heads/topic\n").unwrap();

    let roots = vec![fx.doc.clone(), fx.src.clone()];
    let entries = discover_repos(&roots).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "foo-wt");
    assert_eq!(entries[0].group, "external");
    assert!(entries[0].is_worktree);
}
