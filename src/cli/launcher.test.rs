use super::{SCRIPTS, format_script_header, format_script_row};

#[test]
fn test_scripts_are_unique() {
    let names: Vec<&str> = SCRIPTS.iter().map(|s| s.name).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(names.len(), sorted.len(), "Script names must be unique");
}

#[test]
fn test_script_name_format() {
    for entry in SCRIPTS {
        assert!(
            entry.name.chars().any(|c| c == ' '),
            "Script name '{}' should contain spaces (subcommand path)",
            entry.name
        );
    }
}

#[test]
fn test_script_categories_separated() {
    let mut cats: Vec<&str> = SCRIPTS.iter().map(|s| s.category).collect();
    cats.sort();
    cats.dedup();
    assert!(cats.contains(&"git"));
    assert!(cats.contains(&"opencode"));
    assert!(cats.contains(&"tool"));
    assert!(cats.contains(&"vector"));
    assert!(cats.contains(&"config"));
    assert!(cats.contains(&"dotfiles"));
}

#[test]
fn test_scripts_have_descriptions() {
    for entry in SCRIPTS {
        assert!(
            !entry.description.trim().is_empty(),
            "Script '{}' should have a description",
            entry.name
        );
    }
}

#[test]
fn test_format_script_row_uses_padded_columns() {
    let row = format_script_row(&SCRIPTS[0]);

    assert!(row.starts_with("git         git repo create"));
    assert!(row.contains("  GitHub リポジトリを対話的に作成"));
    assert!(!row.contains('\t'));
}

#[test]
fn test_format_script_header_uses_padded_columns() {
    let header = format_script_header();

    assert!(header.starts_with("カテゴリ"));
    assert!(header.contains("コマンド"));
    assert!(header.ends_with("説明"));
    assert!(!header.contains('\t'));
}

#[test]
fn test_scripts_include_git_sync_and_ship() {
    let names: Vec<&str> = SCRIPTS.iter().map(|s| s.name).collect();
    assert!(
        names.contains(&"git sync"),
        "git sync がランチャーに登録されているべき: {names:?}"
    );
    assert!(
        names.contains(&"git ship"),
        "git ship がランチャーに登録されているべき: {names:?}"
    );
}
