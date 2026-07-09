use std::path::Path;

use console::style;

use super::shared;
use super::shared::{claude_agents_dir, opencode_agents_dir, symlink_dir};

#[derive(Debug, Clone, Copy)]
pub enum SyncMode {
    Sync,
    Check,
    DryRun,
}

pub fn run(mode: SyncMode) -> anyhow::Result<()> {
    let source_dir = shared::chezmoi_source_dir()?;
    let sync_agents_drift = sync_agents(&source_dir, mode)?;
    let sync_skills_drift = sync_skills(&source_dir, mode)?;

    let agent_count = sync_agents_drift.len();
    let skill_count = sync_skills_drift.len();
    let total = agent_count + skill_count;

    match mode {
        SyncMode::Sync => {
            if total > 0 {
                println!(
                    "{} agents: {} 件, skills: {} 件 を同期しました",
                    style("✓").green(),
                    agent_count,
                    skill_count,
                );
            } else {
                println!("{} すべて同期済みです", style("✓").green());
            }
        }
        SyncMode::Check => {
            if total > 0 {
                anyhow::bail!(
                    "{} drift が {} 件あります (agents: {}, skills: {}). mt agent sync を実行してください",
                    style("✗").red(),
                    total,
                    agent_count,
                    skill_count,
                );
            } else {
                println!("{} drift はありません", style("✓").green());
            }
        }
        SyncMode::DryRun => {
            if total > 0 {
                println!(
                    "{} drift: agents {} 件, skills {} 件",
                    style("⟳ dry-run").yellow(),
                    agent_count,
                    skill_count,
                );
                for (name, platform, action) in &sync_agents_drift {
                    println!("  agent {}: {} ({})", name, action, platform);
                }
                for (name, platform, action) in &sync_skills_drift {
                    println!("  skill {}: {} ({})", name, action, platform);
                }
            } else {
                println!("{} drift はありません", style("✓").green());
            }
        }
    }

    Ok(())
}

fn sync_agents(
    source_dir: &Path,
    mode: SyncMode,
) -> anyhow::Result<Vec<(String, String, String)>> {
    let cursor_agents = shared::read_cursor_agents(source_dir)?;
    let mut drift_entries = Vec::new();

    for (name, agent) in &cursor_agents {
        if agent.meta.color.is_empty() {
            anyhow::bail!(
                "Cursor agent '{}' に color が設定されていません。全エージェントに color の付与が必要です",
                name
            );
        }

        let claude_content = shared::generate_claude_agent(agent);
        let opencode_content = shared::generate_opencode_agent(agent);

        let claude_path = claude_agents_dir(source_dir).join(format!("{}.md", name));
        let opencode_path = opencode_agents_dir(source_dir).join(format!("{}.md", name));

        if diff_detected(&claude_path, &claude_content) {
            drift_entries.push((name.clone(), "claude".to_string(), "update".to_string()));
            match mode {
                SyncMode::Sync => shared::write_file_content(&claude_path, &claude_content)?,
                SyncMode::DryRun | SyncMode::Check => {}
            }
        }

        if diff_detected(&opencode_path, &opencode_content) {
            drift_entries.push((name.clone(), "opencode".to_string(), "update".to_string()));
            match mode {
                SyncMode::Sync => shared::write_file_content(&opencode_path, &opencode_content)?,
                SyncMode::DryRun | SyncMode::Check => {}
            }
        }
    }

    cleanup_orphan_agents(source_dir, &cursor_agents, mode, &mut drift_entries)?;

    Ok(drift_entries)
}

fn cleanup_orphan_agents(
    source_dir: &Path,
    cursor_agents: &[(String, shared::AgentFile)],
    mode: SyncMode,
    drift_entries: &mut Vec<(String, String, String)>,
) -> anyhow::Result<()> {
    let canonical: Vec<_> = cursor_agents.iter().map(|(n, _)| n.clone()).collect();

    for platform_dir in &[claude_agents_dir(source_dir), opencode_agents_dir(source_dir)] {
        let platform_name = if platform_dir.ends_with("opencode/agents") {
            "opencode"
        } else {
            "claude"
        };
        let existing = shared::list_agent_files(platform_dir)?;
        for name in &existing {
            if !canonical.contains(name) {
                let path = platform_dir.join(format!("{}.md", name));
                drift_entries.push((name.clone(), platform_name.to_string(), "delete".to_string()));
                match mode {
                    SyncMode::Sync => shared::remove_file(&path)?,
                    SyncMode::DryRun | SyncMode::Check => {}
                }
            }
        }
    }
    Ok(())
}

fn sync_skills(
    source_dir: &Path,
    mode: SyncMode,
) -> anyhow::Result<Vec<(String, String, String)>> {
    let cursor_dir = shared::cursor_skills_dir(source_dir);
    let mut drift_entries = Vec::new();

    let cursor_skills = shared::list_skill_dirs(&cursor_dir)?;

    for platform in &[("claude", shared::claude_skills_dir(source_dir)), ("opencode", shared::opencode_skills_dir(source_dir))] {
        let target_dir = &platform.1;
        let platform_name = platform.0;

        for skill_name in &cursor_skills {
            let src = cursor_dir.join(skill_name);
            let dst = target_dir.join(skill_name);
            let expected_rel = shared::relative_path(&src, target_dir);

            let needs_sync = !dst.exists()
                || (dst.is_symlink() && std::fs::read_link(&dst).ok().as_deref() != Some(&expected_rel))
                || !dst.is_symlink();

            if needs_sync {
                drift_entries.push((
                    skill_name.clone(),
                    platform_name.to_string(),
                    "symlink".to_string(),
                ));
                match mode {
                    SyncMode::Sync => {
                        symlink_dir(&src, &dst)?;
                    }
                    SyncMode::DryRun | SyncMode::Check => {}
                }
            }
        }

        cleanup_orphan_skills(&cursor_dir, target_dir.clone(), &cursor_skills, mode, &mut drift_entries, platform_name)?;
    }

    Ok(drift_entries)
}



fn cleanup_orphan_skills(
    _cursor_dir: &std::path::Path,
    target_dir: std::path::PathBuf,
    cursor_skills: &[String],
    mode: SyncMode,
    drift_entries: &mut Vec<(String, String, String)>,
    platform_name: &str,
) -> anyhow::Result<()> {
    let existing = shared::list_skill_dirs(&target_dir)?;
    for name in &existing {
        if !cursor_skills.contains(name) {
            let path = target_dir.join(name);
            drift_entries.push((name.clone(), platform_name.to_string(), "delete".to_string()));
            match mode {
                SyncMode::Sync => shared::remove_dir_all_if_exists(&path)?,
                SyncMode::DryRun | SyncMode::Check => {}
            }
        }
    }
    Ok(())
}

fn diff_detected(path: &std::path::Path, expected_content: &str) -> bool {
    match std::fs::read_to_string(path) {
        Ok(existing) => existing != expected_content,
        Err(_) => true,
    }
}
