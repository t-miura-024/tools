use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMeta {
    pub name: String,
    pub description: String,
    pub readonly: bool,
    pub color: String,
}

#[derive(Debug, Clone)]
pub struct AgentFile {
    pub meta: AgentMeta,
    pub body: String,
}

pub fn chezmoi_source_dir() -> anyhow::Result<PathBuf> {
    if let Ok(dir) = std::env::var("CHEZMOI_SOURCE_DIR")
        && !dir.is_empty()
    {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    Ok(PathBuf::from(home).join("src/tools/chezmoi"))
}

pub fn cursor_agents_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_cursor/agents")
}

pub fn claude_agents_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_claude/agents")
}

pub fn opencode_agents_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_config/opencode/agents")
}

pub fn cursor_skills_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_cursor/skills")
}

pub fn claude_skills_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_claude/skills")
}

pub fn opencode_skills_dir(source_dir: &Path) -> PathBuf {
    source_dir.join("dot_config/opencode/skills")
}

pub fn parse_frontmatter(content: &str) -> anyhow::Result<(BTreeMap<String, yaml_serde::Value>, String)> {
    let mut lines = content.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        anyhow::bail!("frontmatter の開始区切り (---) が見つかりません");
    }

    let mut yaml_lines = Vec::new();
    for line in &mut lines {
        if line.trim() == "---" {
            break;
        }
        yaml_lines.push(line);
    }

    let body: String = lines
        .collect::<Vec<_>>()
        .join("\n");

    let yaml_str = yaml_lines.join("\n");
    let frontmatter: BTreeMap<String, yaml_serde::Value> = if yaml_str.trim().is_empty() {
        BTreeMap::new()
    } else {
        yaml_serde::from_str(&yaml_str)
            .context("frontmatter の YAML パースに失敗しました")?
    };

    Ok((frontmatter, body))
}

pub fn parse_cursor_agent(content: &str) -> anyhow::Result<AgentFile> {
    let (fm, body) = parse_frontmatter(content)?;

    let name = fm
        .get("name")
        .and_then(|v| v.as_str())
        .context("name フィールドがありません")?
        .to_string();

    let description = fm
        .get("description")
        .and_then(|v| v.as_str())
        .context("description フィールドがありません")?
        .to_string();

    let readonly = fm
        .get("readonly")
        .and_then(|v| v.as_bool())
        .context("readonly フィールドがありません")?;

    let color = fm
        .get("color")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();

    Ok(AgentFile {
        meta: AgentMeta {
            name,
            description,
            readonly,
            color,
        },
        body: body.trim_start().to_string(),
    })
}

pub fn generate_claude_agent(agent: &AgentFile) -> String {
    let mut tools = vec![
        "  - Read".to_string(),
        "  - Grep".to_string(),
        "  - Glob".to_string(),
    ];
    if !agent.meta.readonly {
        tools.insert(0, "  - Write".to_string());
    }
    tools.sort();

    format!(
        "---\n\
         name: {name}\n\
         description: {desc}\n\
         model: inherit\n\
         color: {color}\n\
         tools:\n\
         {tools}\n\
         ---\n\
         {body}",
        name = agent.meta.name,
        desc = agent.meta.description,
        color = agent.meta.color,
        tools = tools.join("\n"),
        body = agent.body,
    )
}

pub fn generate_opencode_agent(agent: &AgentFile) -> String {
    let color = claude_color_to_opencode(&agent.meta.color);

    if agent.meta.readonly {
        format!(
            "---\n\
             description: \"{desc}\"\n\
             mode: \"subagent\"\n\
             color: \"{color}\"\n\
             permission:\n  edit: \"deny\"\n  bash: \"deny\"\n\
             ---\n\
             {body}",
            desc = agent.meta.description,
            color = color,
            body = agent.body,
        )
    } else {
        format!(
            "---\n\
             description: \"{desc}\"\n\
             mode: \"subagent\"\n\
             color: \"{color}\"\n\
             ---\n\
             {body}",
            desc = agent.meta.description,
            color = color,
            body = agent.body,
        )
    }
}

fn claude_color_to_opencode(color: &str) -> &str {
    match color {
        "green" => "success",
        "blue" => "primary",
        "yellow" => "warning",
        "red" => "error",
        _ => "primary",
    }
}

pub fn read_cursor_agents(source_dir: &Path) -> anyhow::Result<Vec<(String, AgentFile)>> {
    let dir = cursor_agents_dir(source_dir);
    let mut agents = Vec::new();
    for entry in fs::read_dir(&dir)
        .with_context(|| format!("agents ディレクトリを読めません: {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md") {
            let content = fs::read_to_string(&path)
                .with_context(|| format!("ファイルを読めません: {}", path.display()))?;
            let agent = parse_cursor_agent(&content)?;
            let name = path
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_string();
            agents.push((name, agent));
        }
    }
    agents.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(agents)
}

pub fn write_file_content(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("ディレクトリを作成できません: {}", parent.display()))?;
    }
    fs::write(path, content)
        .with_context(|| format!("ファイルを書き込めません: {}", path.display()))?;
    Ok(())
}

pub fn remove_file(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        fs::remove_file(path)
            .with_context(|| format!("ファイルを削除できません: {}", path.display()))?;
    }
    Ok(())
}

pub fn remove_dir_all_if_exists(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)
            .with_context(|| format!("ディレクトリを削除できません: {}", path.display()))?;
    }
    Ok(())
}

pub fn list_agent_files(dir: &Path) -> anyhow::Result<Vec<String>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)
        .with_context(|| format!("ディレクトリを読めません: {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md") {
            files.push(
                path.file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    files.sort();
    Ok(files)
}

pub fn symlink_dir(src: &Path, dst: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let rel = relative_path(src, dst.parent().unwrap_or(Path::new(".")));

    if dst.exists() {
        if dst.is_symlink() {
            let target = fs::read_link(dst)?;
            if target == rel {
                return Ok(());
            }
            fs::remove_file(dst)?;
        } else {
            fs::remove_dir_all(dst)?;
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&rel, dst)
            .with_context(|| format!("symlink を作成できません: {} -> {}", dst.display(), rel.display()))?;
    }
    #[cfg(not(unix))]
    {
        anyhow::bail!("symlink は UNIX のみ対応しています");
    }
    Ok(())
}

pub fn relative_path(src: &Path, base: &Path) -> PathBuf {
    let src = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());

    let mut src_components = src.components().peekable();
    let mut base_components = base.components().peekable();

    while src_components.peek() == base_components.peek() {
        src_components.next();
        base_components.next();
    }

    let mut rel = PathBuf::new();
    for _ in base_components {
        rel.push("..");
    }
    for comp in src_components {
        rel.push(comp);
    }
    rel
}

pub fn check_sync_status(source_dir: &Path) -> anyhow::Result<Option<String>> {
    let cursor_agents = read_cursor_agents(source_dir)?;
    let mut issues = Vec::new();

    for (name, agent) in &cursor_agents {
        if agent.meta.color.is_empty() {
            issues.push(format!("agent {} に color 未設定", name));
            continue;
        }

        let claude_content = generate_claude_agent(agent);
        let opencode_content = generate_opencode_agent(agent);

        let claude_path = claude_agents_dir(source_dir).join(format!("{}.md", name));
        let opencode_path = opencode_agents_dir(source_dir).join(format!("{}.md", name));

        if read_possible(&claude_path).as_deref() != Some(&claude_content) {
            issues.push(format!("agent {} (claude) が未同期", name));
        }
        if read_possible(&opencode_path).as_deref() != Some(&opencode_content) {
            issues.push(format!("agent {} (opencode) が未同期", name));
        }
    }

    let canonical: Vec<_> = cursor_agents.iter().map(|(n, _)| n.clone()).collect();
    for platform_dir in &[claude_agents_dir(source_dir), opencode_agents_dir(source_dir)] {
        let existing = list_agent_files(platform_dir)?;
        for name in &existing {
            if !canonical.contains(name) {
                issues.push(format!("agent {} が canonical から削除されたが派生側に残存", name));
            }
        }
    }

    let cursor_skills_dir_path = cursor_skills_dir(source_dir);
    let cursor_skills = list_skill_dirs(&cursor_skills_dir_path)?;
    for platform in &[("claude", claude_skills_dir(source_dir)), ("opencode", opencode_skills_dir(source_dir))] {
        let target_dir = &platform.1;
        let platform_name = platform.0;

        for skill_name in &cursor_skills {
            let src = cursor_skills_dir_path.join(skill_name);
            let dst = target_dir.join(skill_name);
            let expected_rel = relative_path(&src, target_dir);
            let exists_as_symlink = dst.is_symlink() && std::fs::read_link(&dst).ok().as_deref() == Some(&expected_rel);
            if !exists_as_symlink {
                issues.push(format!("skill {} ({}) が未同期（symlink未設定）", skill_name, platform_name));
            }
        }

        let existing = list_skill_dirs(target_dir)?;
        for name in &existing {
            if !cursor_skills.contains(name) {
                issues.push(format!("skill {} ({}) が canonical から削除されたが派生側に残存", name, platform_name));
            }
        }
    }

    if issues.is_empty() {
        Ok(None)
    } else {
        Ok(Some(issues.join("\n")))
    }
}

fn read_possible(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub fn list_skill_dirs(dir: &Path) -> anyhow::Result<Vec<String>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("ディレクトリを読めません: {}", dir.display()))?
    {
        let entry = entry?;
        if entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
            dirs.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    dirs.sort();
    Ok(dirs)
}

#[cfg(test)]
#[path = "shared_test.rs"]
mod tests;
