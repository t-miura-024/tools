use anyhow::Result;
use std::fs;
use std::path::Path;

use super::frontmatter::{AgentFrontmatter, infer_claude_agent_color, parse_markdown_frontmatter};

pub fn sync_claude(src_root: &Path, dest_root: &Path) -> Result<()> {
    sync_claude_agents(src_root, dest_root)?;
    sync_claude_agents_md(src_root, dest_root)?;
    sync_claude_skills(src_root, dest_root)?;

    println!("Synced agent-configs to {}", dest_root.display());
    Ok(())
}

fn sync_claude_agents(src_root: &Path, dest_root: &Path) -> Result<()> {
    let agents_src = src_root.join("agents");
    if !agents_src.exists() {
        return Ok(());
    }

    let agents_dest = dest_root.join("agents");
    fs::create_dir_all(&agents_dest)?;

    let source_files = collect_md_files(&agents_src)?;

    for entry in fs::read_dir(&agents_dest)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_file() && name.ends_with(".md") && !source_files.contains(&name) {
            fs::remove_file(entry.path())?;
        }
    }

    for file_name in &source_files {
        let src = agents_src.join(file_name);
        let dest = agents_dest.join(file_name);
        let content = fs::read_to_string(&src)?;
        let transformed = transform_agent_for_claude(&content)?;
        fs::write(&dest, transformed)?;
    }

    Ok(())
}

fn transform_agent_for_claude(content: &str) -> Result<String> {
    let (frontmatter, body) = parse_markdown_frontmatter(content)?;
    let normalized = normalize_claude_agent_frontmatter(&frontmatter);
    let yaml = super::frontmatter::stringify_frontmatter(&normalized)?;
    Ok(format!("---\n{}---\n{}", yaml, body.trim_start()))
}

fn normalize_claude_agent_frontmatter(source: &AgentFrontmatter) -> AgentFrontmatter {
    let readonly = source.readonly.unwrap_or(false);

    let description = build_claude_agent_description(
        source.name.as_deref().unwrap_or("agent"),
        source.description.as_deref().unwrap_or(""),
    );

    let color = source
        .color
        .clone()
        .unwrap_or_else(|| infer_claude_agent_color(source, readonly));

    let tools = if let Some(tools) = &source.tools {
        Some(tools.clone())
    } else if readonly {
        Some(serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("Read".to_string()),
            serde_yaml::Value::String("Grep".to_string()),
            serde_yaml::Value::String("Glob".to_string()),
        ]))
    } else {
        Some(serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("Read".to_string()),
            serde_yaml::Value::String("Write".to_string()),
            serde_yaml::Value::String("Grep".to_string()),
            serde_yaml::Value::String("Glob".to_string()),
        ]))
    };

    AgentFrontmatter {
        name: source.name.clone(),
        description: Some(description),
        readonly: None,
        model: source.model.clone().or_else(|| Some("inherit".to_string())),
        color: Some(color),
        tools,
        extra: source.extra.clone(),
    }
}

fn build_claude_agent_description(name: &str, original_description: &str) -> String {
    let summary = if original_description.is_empty() {
        format!("{} agent.", name)
    } else {
        original_description.to_string()
    };
    format!("Use this agent when {}", summary)
}

fn sync_claude_agents_md(src_root: &Path, dest_root: &Path) -> Result<()> {
    let agents_md_src = src_root.join("AGENTS.md");
    if !agents_md_src.exists() {
        return Ok(());
    }

    let claude_md_dest = dest_root.join("CLAUDE.md");
    fs::copy(&agents_md_src, &claude_md_dest)?;

    Ok(())
}

fn sync_claude_skills(src_root: &Path, dest_root: &Path) -> Result<()> {
    let skills_src = src_root.join("skills");
    if !skills_src.exists() {
        return Ok(());
    }

    let skills_dest = dest_root.join("skills");
    super::sync::sync_dir_with_delete(&skills_src, &skills_dest)?;

    Ok(())
}

fn collect_md_files(dir: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_file() && name.ends_with(".md") {
            files.push(name);
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
#[path = "claude.test.rs"]
mod tests;
