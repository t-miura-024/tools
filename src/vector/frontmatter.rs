use anyhow::{Context, Result};
use yaml_serde::Value;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocFrontmatter {
    pub title: String,
    pub source: String,
}

impl DocFrontmatter {
    pub fn from_value(value: &Value, title_key: &str, source_key: &str) -> Self {
        let mapping = value.as_mapping();
        let title = mapping
            .and_then(|m| m.get(Value::String(title_key.to_string())))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let source = mapping
            .and_then(|m| m.get(Value::String(source_key.to_string())))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Self { title, source }
    }
}

pub fn parse(content: &str, title_key: &str, source_key: &str) -> Result<(DocFrontmatter, String)> {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return Ok((DocFrontmatter::default(), content.to_string()));
    }

    let body = if let Some(stripped) = content.strip_prefix("---\r\n") {
        stripped
    } else {
        content.strip_prefix("---\n").unwrap_or(content)
    };

    let (frontmatter_end, separator_len) = body
        .find("\n---\n")
        .map(|idx| (idx, 5))
        .or_else(|| body.find("\n---\r\n").map(|idx| (idx, 6)))
        .context("frontmatter の終端 --- が見つかりません")?;

    let frontmatter_str = &body[..frontmatter_end];
    let body_start = frontmatter_end + separator_len;
    let body_text = body[body_start..].to_string();

    let value: Value =
        yaml_serde::from_str(frontmatter_str).context("frontmatter の YAML 解析に失敗しました")?;
    let frontmatter = DocFrontmatter::from_value(&value, title_key, source_key);

    Ok((frontmatter, body_text))
}

#[cfg(test)]
#[path = "frontmatter.test.rs"]
mod tests;
