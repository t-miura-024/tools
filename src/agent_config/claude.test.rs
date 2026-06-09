use super::*;

#[test]
fn test_transform_agent_for_claude_readonly() {
    let content = r#"---
name: test-agent
description: Test agent
readonly: true
---
Body content"#;

    let result = transform_agent_for_claude(content).unwrap();
    assert!(result.contains("tools:"));
    assert!(result.contains("Read"));
    assert!(result.contains("Grep"));
    assert!(result.contains("Glob"));
    assert!(!result.contains("Write"));
}

#[test]
fn test_transform_agent_for_claude_writable() {
    let content = r#"---
name: test-agent
description: Test agent
readonly: false
---
Body content"#;

    let result = transform_agent_for_claude(content).unwrap();
    assert!(result.contains("tools:"));
    assert!(result.contains("Read"));
    assert!(result.contains("Write"));
    assert!(result.contains("Grep"));
    assert!(result.contains("Glob"));
}

#[test]
fn test_transform_agent_for_claude_description() {
    let content = r#"---
name: test-agent
description: Helps with testing
---
Body content"#;

    let result = transform_agent_for_claude(content).unwrap();
    assert!(result.contains("Use this agent when Helps with testing"));
}

#[test]
fn test_transform_agent_for_claude_model() {
    let content = r#"---
name: test-agent
description: Test agent
---
Body content"#;

    let result = transform_agent_for_claude(content).unwrap();
    assert!(result.contains("model: inherit"));
}

#[test]
fn test_transform_agent_for_claude_color() {
    let content = r#"---
name: risk-reviewer
description: Reviews security risks
---
Body content"#;

    let result = transform_agent_for_claude(content).unwrap();
    assert!(result.contains("color: red"));
}
