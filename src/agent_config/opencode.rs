use anyhow::Result;
use std::fs;
use std::path::Path;

use super::frontmatter::{infer_claude_agent_color, parse_markdown_frontmatter, AgentFrontmatter};

pub fn sync_opencode(src_root: &Path, dest_root: &Path) -> Result<()> {
    sync_opencode_agents(src_root, dest_root)?;
    sync_opencode_agents_md(src_root, dest_root)?;
    sync_opencode_skills(src_root, dest_root)?;

    println!("Synced agent-configs to {}", dest_root.display());
    Ok(())
}

fn sync_opencode_agents(src_root: &Path, dest_root: &Path) -> Result<()> {
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
        let transformed = transform_agent_for_opencode(&content)?;
        fs::write(&dest, transformed)?;
    }

    Ok(())
}

fn transform_agent_for_opencode(content: &str) -> Result<String> {
    let (frontmatter, body) = parse_markdown_frontmatter(content)?;
    let normalized = normalize_opencode_agent_frontmatter(&frontmatter);
    let yaml = stringify_opencode_frontmatter(&normalized);
    Ok(format!("---\n{}---\n{}", yaml, body.trim_start()))
}

fn normalize_opencode_agent_frontmatter(source: &AgentFrontmatter) -> AgentFrontmatter {
    let readonly = source.readonly.unwrap_or(false);

    let description = build_opencode_agent_description(
        source.name.as_deref().unwrap_or("agent"),
        source.description.as_deref().unwrap_or(""),
    );

    let mode = infer_opencode_agent_mode(source, readonly);

    let raw_color = source
        .color
        .clone()
        .unwrap_or_else(|| infer_claude_agent_color(source, readonly));
    let color = normalize_opencode_agent_color(&raw_color);

    let permission = build_opencode_agent_permission(source, readonly);

    let mut extra = source.extra.clone();
    extra.remove("name");
    extra.remove("readonly");
    extra.remove("tools");

    if let Some(mode) = mode {
        extra.insert("mode".to_string(), serde_yaml::Value::String(mode));
    }

    if let Some(perm) = permission {
        let mut perm_map = serde_yaml::Mapping::new();
        for (k, v) in perm {
            perm_map.insert(
                serde_yaml::Value::String(k),
                serde_yaml::Value::String(v),
            );
        }
        extra.insert("permission".to_string(), serde_yaml::Value::Mapping(perm_map));
    }

    AgentFrontmatter {
        name: None,
        description: Some(description),
        readonly: None,
        model: source.model.clone(),
        color: Some(color),
        tools: None,
        extra,
    }
}

fn build_opencode_agent_description(name: &str, original_description: &str) -> String {
    if original_description.is_empty() {
        format!("{} agent.", name)
    } else {
        original_description.to_string()
    }
}

fn infer_opencode_agent_mode(source: &AgentFrontmatter, readonly: bool) -> Option<String> {
    if let Some(mode) = source.extra.get("mode") {
        if let Some(mode_str) = mode.as_str() {
            return Some(mode_str.to_string());
        }
    }
    Some(if readonly { "subagent" } else { "all" }.to_string())
}

fn build_opencode_agent_permission(
    source: &AgentFrontmatter,
    readonly: bool,
) -> Option<Vec<(String, String)>> {
    if let Some(perm) = source.extra.get("permission") {
        if let Some(perm_map) = perm.as_mapping() {
            let mut result = Vec::new();
            for (k, v) in perm_map {
                if let (Some(key), Some(val)) = (k.as_str(), v.as_str()) {
                    result.push((key.to_string(), val.to_string()));
                }
            }
            if !result.is_empty() {
                return Some(result);
            }
        }
    }

    if readonly {
        Some(vec![
            ("edit".to_string(), "deny".to_string()),
            ("bash".to_string(), "deny".to_string()),
        ])
    } else {
        None
    }
}

fn normalize_opencode_agent_color(raw: &str) -> String {
    let trimmed = raw.trim();

    if let Some(hex) = trimmed.strip_prefix('#') {
        if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return format!("#{}", hex.to_lowercase());
        }
    }

    let lower = trimmed.to_lowercase();
    let valid_tokens = ["primary", "secondary", "accent", "success", "warning", "error", "info"];
    if valid_tokens.contains(&lower.as_str()) {
        return lower;
    }

    let claude_to_opencode = [
        ("red", "error"),
        ("yellow", "warning"),
        ("green", "success"),
        ("cyan", "info"),
        ("blue", "primary"),
    ];

    for (claude, opencode) in claude_to_opencode {
        if lower == claude {
            return opencode.to_string();
        }
    }

    "primary".to_string()
}

fn stringify_opencode_frontmatter(frontmatter: &AgentFrontmatter) -> String {
    let mut lines = Vec::new();
    let preferred_order = ["description", "mode", "model", "color", "permission"];

    let mut keys: Vec<String> = preferred_order
        .iter()
        .filter_map(|key| {
            if get_field_value(frontmatter, key).is_some() {
                Some(key.to_string())
            } else {
                None
            }
        })
        .collect();

    for key in frontmatter.extra.keys() {
        if !preferred_order.contains(&key.as_str()) {
            keys.push(key.clone());
        }
    }

    for key in keys {
        if let Some(value) = get_field_value(frontmatter, &key) {
            lines.push(format_yaml_line(&key, &value));
        }
    }

    lines.join("\n") + "\n"
}

fn get_field_value(frontmatter: &AgentFrontmatter, key: &str) -> Option<serde_yaml::Value> {
    match key {
        "description" => frontmatter.description.as_ref().map(|s| serde_yaml::Value::String(s.clone())),
        "model" => frontmatter.model.as_ref().map(|s| serde_yaml::Value::String(s.clone())),
        "color" => frontmatter.color.as_ref().map(|s| serde_yaml::Value::String(s.clone())),
        _ => frontmatter.extra.get(key).cloned(),
    }
}

fn format_yaml_line(key: &str, value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(s) if s.contains('\n') => {
            let lines: Vec<String> = s.lines().map(|l| format!("  {}", l)).collect();
            format!("{}: |\n{}", key, lines.join("\n"))
        }
        serde_yaml::Value::String(s) => {
            format!("{}: {}", key, serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s)))
        }
        serde_yaml::Value::Bool(b) => {
            format!("{}: {}", key, b)
        }
        serde_yaml::Value::Number(n) => {
            format!("{}: {}", key, n)
        }
        serde_yaml::Value::Sequence(seq) => {
            let items: Vec<String> = seq
                .iter()
                .filter_map(|v| v.as_str().map(|s| format!("\"{}\"", s)))
                .collect();
            format!("{}: [{}]", key, items.join(", "))
        }
        serde_yaml::Value::Mapping(map) => {
            let mut lines = vec![format!("{}:", key)];
            for (k, v) in map {
                if let Some(key_str) = k.as_str() {
                    let val_str = match v {
                        serde_yaml::Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s)),
                        serde_yaml::Value::Bool(b) => b.to_string(),
                        serde_yaml::Value::Number(n) => n.to_string(),
                        _ => format!("{:?}", v),
                    };
                    lines.push(format!("  {}: {}", key_str, val_str));
                }
            }
            lines.join("\n")
        }
        _ => format!("{}: {:?}", key, value),
    }
}

fn sync_opencode_agents_md(src_root: &Path, dest_root: &Path) -> Result<()> {
    let agents_md_src = src_root.join("AGENTS.md");
    if !agents_md_src.exists() {
        return Ok(());
    }

    let agents_md_dest = dest_root.join("AGENTS.md");
    fs::copy(&agents_md_src, &agents_md_dest)?;

    Ok(())
}

fn sync_opencode_skills(src_root: &Path, dest_root: &Path) -> Result<()> {
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
#[path = "opencode.test.rs"]
mod tests;
