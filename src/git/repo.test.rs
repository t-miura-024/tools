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
fn test_repo_entry_label() {
    let branch = RepoEntry {
        category: "doc".to_string(),
        name: "note".to_string(),
        path: PathBuf::from("/tmp/doc/note"),
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
        head_info: HeadInfo::Branch("main".to_string()),
    }
}

#[test]
fn test_sort_entries_order() {
    let entries = vec![
        entry("src", "tools", "main"),
        entry("doc", "paleo-blog", "main"),
        entry("doc", "note", "main"),
    ];
    let sorted = sort_entries(entries);

    // doc カテゴリが先で、その中は name 昇順
    assert_eq!(sorted[0].name, "note");
    assert_eq!(sorted[0].category, "doc");
    assert_eq!(sorted[1].name, "paleo-blog");
    assert_eq!(sorted[2].name, "tools");
    assert_eq!(sorted[2].category, "src");
}

fn entry(category: &str, name: &str, branch: &str) -> RepoEntry {
    RepoEntry {
        category: category.to_string(),
        name: name.to_string(),
        path: PathBuf::from(format!("/tmp/{category}/{name}")),
        head_info: HeadInfo::Branch(branch.to_string()),
    }
}

#[test]
fn test_format_repo_rows_padded_columns() {
    let entries = vec![
        entry("doc", "note", "main"),
        entry("doc", "paleo-blog", "main"),
    ];
    let rows = format_repo_rows(&entries);

    // ヘッダー行: 3 カラムが 2 スペース区切りで左寄せパディングされている
    let header_line = rows.lines().next().unwrap();
    assert!(
        header_line.starts_with("category  name        branch"),
        "ヘッダー行のフォーマット: {header_line:?}"
    );

    // 本体: padded 後に \t + パス
    let note_line = rows
        .lines()
        .find(|l| l.contains("/tmp/doc/note\n") || l.ends_with("/tmp/doc/note"))
        .expect("note 行が含まれる");
    assert!(
        note_line.starts_with("doc       note        [main]"),
        "note 行の左寄せパディング: {note_line:?}"
    );
    assert!(
        note_line.contains("[main]\t/tmp/doc/note"),
        "note 行の末尾はタブ区切りでパス: {note_line:?}"
    );
}

#[test]
fn test_parse_repo_selection() {
    let line = "doc       note        [main]\t/Users/mt/doc/note";
    let path = parse_repo_selection(line).unwrap();
    assert_eq!(path, "/Users/mt/doc/note");
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

    /// worktree pointer ファイル（.git が通常ファイル）を持つ疑似 worktree を作る。
    /// 親が探索範囲外にある場合を再現するために、worktree メタデータを fixture の tmp 内に置く。
    fn make_worktree_pointer(&self, category: &str, worktree_name: &str, branch: &str) -> PathBuf {
        let root = if category == "doc" {
            &self.doc
        } else {
            &self.src
        };
        let path = root.join(worktree_name);
        fs::create_dir_all(&path).unwrap();
        let external_git = self
            ._tmp
            .path()
            .join("external/.git/worktrees")
            .join(worktree_name);
        fs::create_dir_all(&external_git).unwrap();
        fs::write(
            path.join(".git"),
            format!("gitdir: {}\n", external_git.display()),
        )
        .unwrap();
        fs::write(
            external_git.join("HEAD"),
            format!("ref: refs/heads/{branch}\n"),
        )
        .unwrap();
        path
    }
}

#[test]
fn test_discover_repos_finds_only_main_repos() {
    let fx = Fixture::new();
    fx.make_main_repo("doc", "note", "main");
    fx.make_main_repo("doc", "paleo-blog", "main");
    fx.make_main_repo("src", "tools", "main");
    // worktree（.git が pointer ファイル）は除外される
    fx.make_worktree_pointer("doc", "note-wt-1", "topic/a");

    let roots = vec![fx.doc.clone(), fx.src.clone()];
    let mut entries = discover_repos(&roots).unwrap();
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    assert_eq!(entries.len(), 3);

    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"note"));
    assert!(names.contains(&"paleo-blog"));
    assert!(names.contains(&"tools"));
    assert!(!names.contains(&"note-wt-1"));

    let note = entries.iter().find(|e| e.name == "note").unwrap();
    assert!(matches!(note.head_info, HeadInfo::Branch(ref b) if b == "main"));
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
