use std::collections::HashSet;

use clap::Parser;

use super::{
    EXCLUDED, ScriptEntry, format_script_header, format_script_row, is_wrapped, leaf_entries,
    script_entries,
};
use crate::Cli;

#[test]
fn test_scripts_are_unique() {
    let entries = script_entries();
    let names: Vec<&str> = entries.iter().map(|s| s.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(names.len(), sorted.len(), "Script names must be unique");
}

#[test]
fn test_script_names_are_clap_paths() {
    let entries = script_entries();
    for entry in &entries {
        assert!(
            !entry.name.trim().is_empty(),
            "Script name should not be empty"
        );
        assert!(
            entry.name.split(' ').all(|token| !token.is_empty()),
            "Script name '{}' should be a space-separated subcommand path",
            entry.name
        );
    }
}

#[test]
fn test_script_categories_separated() {
    let entries = script_entries();
    let mut cats: Vec<&str> = entries.iter().map(|s| s.category.as_str()).collect();
    cats.sort();
    cats.dedup();
    assert!(cats.contains(&"git"));
    assert!(cats.contains(&"opencode"));
    assert!(cats.contains(&"tool"));
    assert!(cats.contains(&"vector"));
    assert!(cats.contains(&"config"));
    assert!(cats.contains(&"dotfiles"));
    assert!(cats.contains(&"hunk"));
}

#[test]
fn test_scripts_have_descriptions() {
    let entries = script_entries();
    for entry in &entries {
        assert!(
            !entry.description.trim().is_empty(),
            "Script '{}' should have a description",
            entry.name
        );
    }
}

#[test]
fn test_format_script_row_uses_padded_columns() {
    let entry = ScriptEntry {
        name: "git repo create".to_string(),
        category: "git".to_string(),
        description: "GitHub リポジトリを対話的に作成".to_string(),
    };

    let row = format_script_row(&entry);

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
    let entries = script_entries();
    let names: Vec<&str> = entries.iter().map(|s| s.name.as_str()).collect();
    assert!(
        names.contains(&"git sync"),
        "git sync がランチャーに登録されているべき: {names:?}"
    );
    assert!(
        names.contains(&"git ship"),
        "git ship がランチャーに登録されているべき: {names:?}"
    );
}

#[test]
fn test_scripts_include_tool_bun_upgrade() {
    let entries = script_entries();
    let names: Vec<&str> = entries.iter().map(|s| s.name.as_str()).collect();
    assert!(
        names.contains(&"tool bun upgrade"),
        "tool bun upgrade が clap から自動登録されているべき: {names:?}"
    );
}

#[test]
fn test_scripts_include_herdr_workspace_template() {
    let entries = script_entries();
    let names: Vec<&str> = entries.iter().map(|s| s.name.as_str()).collect();
    for expected in [
        "herdr workspace duplicate",
        "herdr workspace template create",
        "herdr workspace template apply",
        "herdr workspace template delete",
    ] {
        assert!(
            names.contains(&expected),
            "{expected} がランチャーに登録されているべき: {names:?}"
        );
    }
}

#[test]
fn test_all_clap_leaves_are_registered_or_excluded() {
    let entries = script_entries();
    let entry_names: HashSet<&str> = entries.iter().map(|s| s.name.as_str()).collect();
    for leaf in leaf_entries() {
        if EXCLUDED.contains(&leaf.name.as_str()) {
            continue;
        }
        assert!(
            entry_names.contains(leaf.name.as_str()),
            "clap リーフ {} がランチャーに未登録です",
            leaf.name
        );
    }
}

#[test]
fn test_excluded_are_real_clap_leaves() {
    let leaf_names: HashSet<String> = leaf_entries().into_iter().map(|s| s.name).collect();
    for name in EXCLUDED {
        assert!(
            leaf_names.contains(*name),
            "EXCLUDED の {} は clap リーフではありません",
            name
        );
    }
}

#[test]
fn test_script_entries_parse_via_clap() {
    let entries = script_entries();
    for entry in &entries {
        if is_wrapped(&entry.name) {
            continue;
        }
        let tokens =
            std::iter::once("mt".to_string()).chain(entry.name.split(' ').map(str::to_string));
        let cli = Cli::try_parse_from(tokens);
        assert!(
            cli.is_ok(),
            "スクリプト {} が clap でパースできません: {:?}",
            entry.name,
            cli.as_ref().err()
        );
        assert!(
            cli.unwrap().command.is_some(),
            "スクリプト {} の実行コマンドが特定できません",
            entry.name
        );
    }
}
