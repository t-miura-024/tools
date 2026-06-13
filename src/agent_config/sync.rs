use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const TARGETS: &[&str] = &["agents", "skills"];

pub fn run() -> Result<()> {
    let src_root = find_agent_configs_dir()?;
    let home = std::env::var("HOME").context("HOME environment variable not set")?;

    let cursor_dest = PathBuf::from(&home).join(".cursor");
    sync_cursor(&src_root, &cursor_dest)?;
    println!("Synced agent-configs to {}", cursor_dest.display());

    let claude_dest = PathBuf::from(&home).join(".claude");
    super::claude::sync_claude(&src_root, &claude_dest)?;

    let opencode_dest = PathBuf::from(&home).join(".config").join("opencode");
    super::opencode::sync_opencode(&src_root, &opencode_dest)?;

    Ok(())
}

fn find_agent_configs_dir() -> Result<PathBuf> {
    let exe_dir = std::env::current_exe()
        .context("Failed to get current executable path")?
        .parent()
        .context("Failed to get parent directory")?
        .to_path_buf();

    let candidates = [
        exe_dir.join("agent-configs"),
        exe_dir.join("../agent-configs"),
        PathBuf::from("agent-configs"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.canonicalize()?);
        }
    }

    anyhow::bail!("agent-configs directory not found")
}

fn sync_cursor(src_root: &Path, dest_root: &Path) -> Result<()> {
    for target in TARGETS {
        let src = src_root.join(target);
        let dest = dest_root.join(target);

        if !src.exists() {
            continue;
        }

        sync_dir_with_delete(&src, &dest)?;
    }

    Ok(())
}

pub fn sync_dir_with_delete(src: &Path, dest: &Path) -> Result<()> {
    if !dest.exists() {
        fs::create_dir_all(dest)?;
    }

    let mut src_entries: Vec<String> = Vec::new();

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        src_entries.push(name.clone());

        let src_path = entry.path();
        let dest_path = dest.join(&name);

        if src_path.is_dir() {
            sync_dir_with_delete(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }

    for entry in fs::read_dir(dest)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();

        if !src_entries.contains(&name) {
            let dest_path = entry.path();
            if dest_path.is_dir() {
                fs::remove_dir_all(&dest_path)?;
            } else {
                fs::remove_file(&dest_path)?;
            }
        }
    }

    Ok(())
}

pub fn sync_dir_additive(src: &Path, dest: &Path) -> Result<()> {
    if !dest.exists() {
        fs::create_dir_all(dest)?;
    }

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest.join(&file_name);

        if src_path.is_dir() {
            fs::create_dir_all(&dest_path)?;
            sync_dir_additive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }

    Ok(())
}

#[cfg(test)]
#[path = "sync.test.rs"]
mod tests;
