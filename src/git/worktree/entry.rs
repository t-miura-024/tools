use std::path::{Path, PathBuf};
use std::process::Command;

use regex::Regex;

use crate::git::common;

pub(super) struct WorktreeEntry {
    pub(super) path: String,
    pub(super) head: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) is_bare: bool,
    pub(super) is_detached: bool,
    pub(super) shortstat: String,
}

impl WorktreeEntry {
    pub(super) fn name(&self) -> String {
        Path::new(&self.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&self.path)
            .to_string()
    }

    pub(super) fn label(&self) -> String {
        if self.is_bare {
            "(bare)".to_string()
        } else if self.is_detached {
            let short_head = self
                .head
                .as_deref()
                .map(|head| head.chars().take(7).collect::<String>())
                .filter(|head| !head.is_empty())
                .unwrap_or_else(|| "detached".to_string());
            format!("({short_head})")
        } else {
            format!("[{}]", self.branch.as_deref().unwrap_or("?"))
        }
    }
}

#[derive(Default)]
struct WorktreeBuilder {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
}

impl WorktreeBuilder {
    fn push_if_ready(&mut self, entries: &mut Vec<WorktreeEntry>) {
        if let Some(path) = self.path.take() {
            entries.push(WorktreeEntry {
                path,
                head: self.head.take(),
                branch: self.branch.take(),
                is_bare: self.is_bare,
                is_detached: self.is_detached,
                shortstat: "+0 -0".to_string(),
            });
        }

        self.is_bare = false;
        self.is_detached = false;
    }
}

pub(super) fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current = WorktreeBuilder::default();

    for line in output.lines() {
        if line.is_empty() {
            current.push_if_ready(&mut entries);
        } else if let Some(path) = line.strip_prefix("worktree ") {
            current.push_if_ready(&mut entries);
            current.path = Some(path.to_string());
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        } else if line == "bare" {
            current.is_bare = true;
        } else if line == "detached" {
            current.is_detached = true;
        }
    }

    current.push_if_ready(&mut entries);
    entries
}

pub(super) fn collect_shortstat(entries: &mut [WorktreeEntry]) {
    for entry in entries.iter_mut() {
        if entry.is_bare {
            continue;
        }
        let output = Command::new("git")
            .args(["-C", &entry.path, "diff", "--shortstat"])
            .output();
        if let Ok(out) = output
            && out.status.success()
        {
            entry.shortstat = parse_shortstat(&String::from_utf8_lossy(&out.stdout));
        }
    }
}

fn parse_shortstat(output: &str) -> String {
    let trimmed = output.trim();
    let insertions = parse_shortstat_count(trimmed, r"(\d+) insertions?\(\+\)");
    let deletions = parse_shortstat_count(trimmed, r"(\d+) deletions?\(-\)");
    format!("+{insertions} -{deletions}")
}

fn parse_shortstat_count(s: &str, pattern: &str) -> u32 {
    Regex::new(pattern)
        .ok()
        .and_then(|re| re.captures(s))
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .unwrap_or(0)
}

pub fn find_worktree_for_branch(branch: &str) -> Option<PathBuf> {
    let output = common::command_output("git", &["worktree", "list", "--porcelain"]).ok()?;
    for entry in parse_worktree_porcelain(&output) {
        if entry.branch.as_deref() == Some(branch) {
            return Some(PathBuf::from(entry.path));
        }
    }
    None
}

#[cfg(test)]
#[path = "entry.test.rs"]
mod tests;
