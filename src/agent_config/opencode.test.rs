use super::*;

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
