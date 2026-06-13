use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readonly: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<serde_yaml::Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub fn parse_markdown_frontmatter(content: &str) -> Result<(AgentFrontmatter, String)> {
    if !content.starts_with("---\n") {
        return Ok((AgentFrontmatter::default(), content.to_string()));
    }

    let end = content[4..]
        .find("\n---\n")
        .context("Invalid frontmatter: no closing ---")?;

    let frontmatter_str = &content[4..4 + end];
    let body = &content[4 + end + 5..];

    let frontmatter: AgentFrontmatter =
        serde_yaml::from_str(frontmatter_str).context("Failed to parse frontmatter YAML")?;

    Ok((frontmatter, body.to_string()))
}

pub fn stringify_frontmatter(frontmatter: &AgentFrontmatter) -> Result<String> {
    let yaml = serde_yaml::to_string(frontmatter)?;
    Ok(yaml)
}

pub fn infer_claude_agent_color(source: &AgentFrontmatter, readonly: bool) -> String {
    let name = format!(
        "{} {}",
        source.name.as_deref().unwrap_or(""),
        source.description.as_deref().unwrap_or("")
    )
    .to_lowercase();

    if name.contains("risk") || name.contains("security") {
        "red".to_string()
    } else if name.contains("validator") || name.contains("reviewer") || name.contains("audit") {
        "yellow".to_string()
    } else if name.contains("writer") || name.contains("creator") || name.contains("implementer") {
        "green".to_string()
    } else if readonly {
        "cyan".to_string()
    } else {
        "blue".to_string()
    }
}

#[cfg(test)]
#[path = "frontmatter.test.rs"]
mod tests;
