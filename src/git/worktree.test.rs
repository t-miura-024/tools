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
