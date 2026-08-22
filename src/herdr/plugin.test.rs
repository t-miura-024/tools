use super::*;
use serde_json::json;

fn github_plugin(plugin_id: &str, shorthand_parts: (&str, &str, &str)) -> serde_json::Value {
    json!({
        "plugin_id": plugin_id,
        "enabled": true,
        "source": {
            "kind": "github",
            "owner": shorthand_parts.0,
            "repo": shorthand_parts.1,
            "subdir": shorthand_parts.2,
        }
    })
}

#[test]
fn test_parse_manifest_reads_plugin_sources() {
    let content = r#"
[[plugin]]
source = "zenbu-labs/terminal-browser/herdr-plugin"

[[plugin]]
source = "zenbu-labs/terminal-code/herdr-plugin"
"#;
    assert_eq!(
        parse_manifest(content).unwrap(),
        vec![
            "zenbu-labs/terminal-browser/herdr-plugin".to_string(),
            "zenbu-labs/terminal-code/herdr-plugin".to_string(),
        ]
    );
}

#[test]
fn test_parse_manifest_rejects_duplicate_and_empty_source() {
    let duplicate = r#"
[[plugin]]
source = "owner/repo"

[[plugin]]
source = "owner/repo"
"#;
    assert!(parse_manifest(duplicate).is_err());

    let empty = r#"
[[plugin]]
source = ""
"#;
    assert!(parse_manifest(empty).is_err());
}

#[test]
fn test_parse_manifest_allows_no_plugins() {
    assert_eq!(parse_manifest("").unwrap(), Vec::<String>::new());
}

#[test]
fn test_github_shorthand_builds_owner_repo_subdir() {
    let plugin: InstalledPlugin = serde_json::from_value(github_plugin(
        "zenbu-labs.terminal-browser",
        ("zenbu-labs", "terminal-browser", "herdr-plugin"),
    ))
    .unwrap();
    assert_eq!(
        plugin.github_shorthand(),
        Some("zenbu-labs/terminal-browser/herdr-plugin".to_string())
    );
}

#[test]
fn test_github_shorthand_without_subdir() {
    let value = json!({
        "plugin_id": "example.layout",
        "source": { "kind": "github", "owner": "example", "repo": "layout" }
    });
    let plugin: InstalledPlugin = serde_json::from_value(value).unwrap();
    assert_eq!(
        plugin.github_shorthand(),
        Some("example/layout".to_string())
    );
}

#[test]
fn test_non_github_plugin_is_out_of_scope() {
    let value = json!({
        "plugin_id": "example.local",
        "source": { "kind": "link", "path": "/tmp/example" }
    });
    let plugin: InstalledPlugin = serde_json::from_value(value).unwrap();
    assert_eq!(plugin.github_shorthand(), None);
}

#[test]
fn test_parse_plugin_list_parses_herdr_response() {
    let output = json!({
        "id": "cli:plugin",
        "result": {
            "type": "plugin_list",
            "plugins": [
                github_plugin(
                    "zenbu-labs.terminal-browser",
                    ("zenbu-labs", "terminal-browser", "herdr-plugin")
                ),
                github_plugin(
                    "zenbu-labs.tode",
                    ("zenbu-labs", "terminal-code", "herdr-plugin")
                )
            ]
        }
    })
    .to_string();

    let plugins = parse_plugin_list(&output).unwrap();
    assert_eq!(plugins.len(), 2);
    assert_eq!(
        installed_github_shorthands(&plugins),
        vec![
            "zenbu-labs/terminal-browser/herdr-plugin".to_string(),
            "zenbu-labs/terminal-code/herdr-plugin".to_string(),
        ]
    );
}

#[test]
fn test_drift_computation_reports_missing_and_extras() {
    let desired = vec![
        "zenbu-labs/terminal-browser/herdr-plugin".to_string(),
        "zenbu-labs/terminal-code/herdr-plugin".to_string(),
    ];
    let installed = vec![
        "zenbu-labs/terminal-code/herdr-plugin".to_string(),
        "someone-else/extra-plugin".to_string(),
    ];

    assert_eq!(
        missing_of(&desired, &installed),
        vec!["zenbu-labs/terminal-browser/herdr-plugin".to_string()]
    );
    assert_eq!(
        extras_of(&desired, &installed),
        vec!["someone-else/extra-plugin".to_string()]
    );
}
