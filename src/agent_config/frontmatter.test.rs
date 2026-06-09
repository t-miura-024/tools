use super::*;

#[test]
fn test_parse_markdown_frontmatter_basic() {
    let content = r#"---
name: test-agent
description: Test agent description
readonly: true
---
Body content here"#;

    let (frontmatter, body) = parse_markdown_frontmatter(content).unwrap();
    assert_eq!(frontmatter.name, Some("test-agent".to_string()));
    assert_eq!(
        frontmatter.description,
        Some("Test agent description".to_string())
    );
    assert_eq!(frontmatter.readonly, Some(true));
    assert_eq!(body, "Body content here");
}

#[test]
fn test_parse_markdown_frontmatter_no_frontmatter() {
    let content = "Just body content";
    let (frontmatter, body) = parse_markdown_frontmatter(content).unwrap();
    assert_eq!(frontmatter.name, None);
    assert_eq!(body, "Just body content");
}

#[test]
fn test_parse_markdown_frontmatter_with_tools() {
    let content = r#"---
name: test-agent
tools: ["Read", "Write", "Grep"]
---
Body"#;

    let (frontmatter, _body) = parse_markdown_frontmatter(content).unwrap();
    assert!(frontmatter.tools.is_some());
}

#[test]
fn test_infer_claude_agent_color_risk() {
    let frontmatter = AgentFrontmatter {
        name: Some("risk-reviewer".to_string()),
        description: Some("Reviews security risks".to_string()),
        ..Default::default()
    };
    assert_eq!(infer_claude_agent_color(&frontmatter, false), "red");
}

#[test]
fn test_infer_claude_agent_color_validator() {
    let frontmatter = AgentFrontmatter {
        name: Some("validator".to_string()),
        description: Some("Validates code".to_string()),
        ..Default::default()
    };
    assert_eq!(infer_claude_agent_color(&frontmatter, false), "yellow");
}

#[test]
fn test_infer_claude_agent_color_writer() {
    let frontmatter = AgentFrontmatter {
        name: Some("writer".to_string()),
        description: Some("Writes code".to_string()),
        ..Default::default()
    };
    assert_eq!(infer_claude_agent_color(&frontmatter, false), "green");
}

#[test]
fn test_infer_claude_agent_color_readonly() {
    let frontmatter = AgentFrontmatter {
        name: Some("generic".to_string()),
        description: Some("Generic agent".to_string()),
        ..Default::default()
    };
    assert_eq!(infer_claude_agent_color(&frontmatter, true), "cyan");
}

#[test]
fn test_infer_claude_agent_color_default() {
    let frontmatter = AgentFrontmatter {
        name: Some("generic".to_string()),
        description: Some("Generic agent".to_string()),
        ..Default::default()
    };
    assert_eq!(infer_claude_agent_color(&frontmatter, false), "blue");
}
