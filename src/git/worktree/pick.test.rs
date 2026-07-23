use super::*;

#[test]
fn test_format_worktree_rows() {
    let entries = vec![WorktreeEntry {
        path: "/repo/main".to_string(),
        head: Some("abcdef1234567890".to_string()),
        branch: Some("main".to_string()),
        is_bare: false,
        is_detached: false,
        shortstat: "+0 -0".to_string(),
    }];

    let rows = format_worktree_rows(&entries, "/repo/main");

    assert!(rows.contains("main"));
    assert!(rows.contains("[main]"));
    assert!(
        rows.contains("\x1b[32m+0\x1b[0m \x1b[31m-0\x1b[0m"),
        "shortstat は ANSI 付きで出力されるべき: {rows:?}"
    );
    assert!(rows.contains("\t/repo/main"));
}

#[test]
fn test_format_worktree_rows_includes_shortstat_column() {
    let entries = vec![
        WorktreeEntry {
            path: "/repo/clean".to_string(),
            head: Some("aaaaaaaaaaaaaaaa".to_string()),
            branch: Some("main".to_string()),
            is_bare: false,
            is_detached: false,
            shortstat: "+0 -0".to_string(),
        },
        WorktreeEntry {
            path: "/repo/dirty".to_string(),
            head: Some("bbbbbbbbbbbbbbbb".to_string()),
            branch: Some("feature".to_string()),
            is_bare: false,
            is_detached: false,
            shortstat: "+12 -5".to_string(),
        },
    ];

    let rows = format_worktree_rows(&entries, "/repo/clean");

    // タブで区切られた隠しパス（col 2）の前に shortstat が並ぶ
    let dirty_line = rows
        .lines()
        .find(|line| line.contains("/repo/dirty"))
        .expect("dirty 行が存在するはず");
    assert!(
        dirty_line.contains("\x1b[32m+12\x1b[0m \x1b[31m-5\x1b[0m"),
        "dirty 行に ANSI 付き shortstat が含まれるべき: {dirty_line:?}"
    );

    // clean 行にも +0 -0 が入って列幅が揃う
    let clean_line = rows
        .lines()
        .find(|line| line.contains("/repo/clean"))
        .expect("clean 行が存在するはず");
    assert!(
        clean_line.contains("\x1b[32m+0\x1b[0m \x1b[31m-0\x1b[0m"),
        "clean 行にも ANSI 付き +0 -0 が含まれるべき: {clean_line:?}"
    );
    assert!(
        clean_line.contains("\t/repo/clean"),
        "clean 行にパス区切りが含まれるべき: {clean_line:?}"
    );
    // 名前・ラベル・shortstat 列の間は 2 スペース区切り
    let parts: Vec<&str> = clean_line.split('\t').collect();
    assert_eq!(parts.len(), 2, "タブで 2 列に分かれるべき: {clean_line:?}");
}

#[test]
fn test_format_worktree_rows_emits_ansi_for_shortstat() {
    // wt ブリッジ経由 ($(...)) では mt の stdout が pipe になり
    // console::Style は既定で ANSI を落とす。force_styling(true) で
    // TTY 判定とは無関係に ANSI が出ることを担保する。
    let entries = vec![WorktreeEntry {
        path: "/repo/dirty".to_string(),
        head: Some("aaaaaaaaaaaaaaaa".to_string()),
        branch: Some("feature".to_string()),
        is_bare: false,
        is_detached: false,
        shortstat: "+12 -5".to_string(),
    }];

    // current に path を渡して current マーカーも発火させる
    let rows = format_worktree_rows(&entries, "/repo/dirty");

    assert!(
        rows.contains("\x1b[32m+12\x1b[0m"),
        "+N 側が緑 (\\x1b[32m) でレンダリングされるべき: {rows:?}"
    );
    assert!(
        rows.contains("\x1b[31m-5\x1b[0m"),
        "-M 側が赤 (\\x1b[31m) でレンダリングされるべき: {rows:?}"
    );
    assert!(
        rows.contains("\x1b[32m\x1b[1m●\x1b[0m"),
        "current マーカーも ANSI 付きで出力されるべき: {rows:?}"
    );
}
