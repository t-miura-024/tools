use super::*;
use std::fs;
use tempfile::TempDir;

#[test]
fn test_transform_agent_for_opencode_readonly() {
    let content = r#"---
name: test-agent
description: Test agent
readonly: true
---
Body content"#;

    let result = transform_agent_for_opencode(content).unwrap();
    assert!(result.contains("mode: \"subagent\""));
    assert!(result.contains("permission:"));
    assert!(result.contains("edit: \"deny\""));
    assert!(result.contains("bash: \"deny\""));
    assert!(!result.contains("name:"));
}

#[test]
fn test_transform_agent_for_opencode_writable() {
    let content = r#"---
name: test-agent
description: Test agent
readonly: false
---
Body content"#;

    let result = transform_agent_for_opencode(content).unwrap();
    assert!(result.contains("mode: \"all\""));
    assert!(!result.contains("permission:"));
}

#[test]
fn test_transform_agent_for_opencode_description() {
    let content = r#"---
name: test-agent
description: Helps with testing
---
Body content"#;

    let result = transform_agent_for_opencode(content).unwrap();
    assert!(result.contains("Helps with testing"));
}

#[test]
fn test_transform_agent_for_opencode_color() {
    let content = r#"---
name: risk-reviewer
description: Reviews security risks
---
Body content"#;

    let result = transform_agent_for_opencode(content).unwrap();
    assert!(result.contains("color: \"error\""));
}

#[test]
fn test_normalize_opencode_agent_color_hex() {
    assert_eq!(normalize_opencode_agent_color("#FF0000"), "#ff0000");
    assert_eq!(normalize_opencode_agent_color("#00ff00"), "#00ff00");
}

#[test]
fn test_normalize_opencode_agent_color_token() {
    assert_eq!(normalize_opencode_agent_color("primary"), "primary");
    assert_eq!(normalize_opencode_agent_color("success"), "success");
    assert_eq!(normalize_opencode_agent_color("warning"), "warning");
}

#[test]
fn test_normalize_opencode_agent_color_claude_mapping() {
    assert_eq!(normalize_opencode_agent_color("red"), "error");
    assert_eq!(normalize_opencode_agent_color("yellow"), "warning");
    assert_eq!(normalize_opencode_agent_color("green"), "success");
    assert_eq!(normalize_opencode_agent_color("cyan"), "info");
    assert_eq!(normalize_opencode_agent_color("blue"), "primary");
}

#[test]
fn test_normalize_opencode_agent_color_invalid() {
    assert_eq!(normalize_opencode_agent_color("invalid"), "primary");
    assert_eq!(normalize_opencode_agent_color("#xyz"), "primary");
}

#[test]
fn test_sync_opencode_plugins_basic() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    let plugins_src = src.path().join("opencode").join("plugins");
    fs::create_dir_all(&plugins_src).unwrap();
    fs::write(plugins_src.join("cmux-notify.ts"), "plugin source").unwrap();

    sync_opencode_plugins(src.path(), dest.path()).unwrap();

    let deployed = dest.path().join("plugins").join("cmux-notify.ts");
    assert!(deployed.exists());
    assert_eq!(fs::read_to_string(&deployed).unwrap(), "plugin source");
}

#[test]
fn test_sync_opencode_plugins_preserves_user_files() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    let plugins_src = src.path().join("opencode").join("plugins");
    fs::create_dir_all(&plugins_src).unwrap();
    fs::write(plugins_src.join("cmux-notify.ts"), "managed").unwrap();

    let plugins_dest = dest.path().join("plugins");
    fs::create_dir_all(&plugins_dest).unwrap();
    fs::write(plugins_dest.join("cursor-hook-bridge.ts"), "user-managed").unwrap();
    let user_subdir = plugins_dest.join("agent-hooks");
    fs::create_dir_all(&user_subdir).unwrap();
    fs::write(user_subdir.join("block.ts"), "user-sub").unwrap();

    sync_opencode_plugins(src.path(), dest.path()).unwrap();

    assert!(
        plugins_dest.join("cmux-notify.ts").exists(),
        "managed plugin must be deployed"
    );
    assert!(
        plugins_dest.join("cursor-hook-bridge.ts").exists(),
        "user-managed plugin must be preserved"
    );
    assert_eq!(
        fs::read_to_string(plugins_dest.join("cursor-hook-bridge.ts")).unwrap(),
        "user-managed"
    );
    assert!(
        user_subdir.exists(),
        "user-managed subdirectory must be preserved"
    );
    assert!(user_subdir.join("block.ts").exists());
}

#[test]
fn test_sync_opencode_plugins_overwrites_existing_managed() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    let plugins_src = src.path().join("opencode").join("plugins");
    fs::create_dir_all(&plugins_src).unwrap();
    fs::write(plugins_src.join("cmux-notify.ts"), "new").unwrap();

    let plugins_dest = dest.path().join("plugins");
    fs::create_dir_all(&plugins_dest).unwrap();
    fs::write(plugins_dest.join("cmux-notify.ts"), "old").unwrap();

    sync_opencode_plugins(src.path(), dest.path()).unwrap();

    assert_eq!(
        fs::read_to_string(plugins_dest.join("cmux-notify.ts")).unwrap(),
        "new"
    );
}

#[test]
fn test_sync_opencode_plugins_no_source_dir() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    sync_opencode_plugins(src.path(), dest.path()).unwrap();

    assert!(!dest.path().join("plugins").exists());
}
