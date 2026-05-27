use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::Context;
use console::Style;

struct WorktreeEntry {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
}

impl WorktreeEntry {
    fn name(&self) -> String {
        Path::new(&self.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&self.path)
            .to_string()
    }

    fn label(&self) -> String {
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
            });
        }

        self.is_bare = false;
        self.is_detached = false;
    }
}

pub fn select() -> anyhow::Result<()> {
    ensure_inside_git_repo()?;
    ensure_fzf()?;

    let current = command_output("git", &["rev-parse", "--show-toplevel"])
        .context("現在の Git リポジトリルートを取得できませんでした")?;
    let porcelain = command_output("git", &["worktree", "list", "--porcelain"])
        .context("git worktree の一覧を取得できませんでした")?;
    let entries = parse_worktree_porcelain(&porcelain);

    if entries.is_empty() {
        anyhow::bail!("git worktree が見つかりませんでした");
    }

    let input = "● current worktree\n".to_string() + &format_worktree_rows(&entries, &current);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--delimiter",
            "\t",
            "--with-nth",
            "1",
            "--header-lines",
            "1",
            "--prompt",
            "worktree> ",
        ],
    )?;

    let Some(target) = selected.trim_end().rsplit('\t').next() else {
        anyhow::bail!("worktree の選択結果を解析できませんでした");
    };

    if target.is_empty() || target == selected.trim_end() {
        anyhow::bail!("worktree の選択結果を解析できませんでした");
    }

    println!("{target}");
    Ok(())
}

fn ensure_inside_git_repo() -> anyhow::Result<()> {
    let status = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("git の実行に失敗しました")?;

    if !status.success() {
        anyhow::bail!("Not inside a git repository.");
    }

    Ok(())
}

fn ensure_fzf() -> anyhow::Result<()> {
    let status = Command::new("fzf")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if !matches!(status, Ok(status) if status.success()) {
        anyhow::bail!(
            "fzf がインストールされていません。brew install fzf などでインストールしてください"
        );
    }

    Ok(())
}

fn command_output(command: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .with_context(|| format!("{command} の実行に失敗しました"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{command} が失敗しました: {}", stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
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

fn format_worktree_rows(entries: &[WorktreeEntry], current: &str) -> String {
    let max_name_width = entries
        .iter()
        .map(|entry| entry.name().chars().count())
        .max()
        .unwrap_or(0);
    let current_dot = Style::new().green().bold().apply_to("●").to_string();

    entries
        .iter()
        .map(|entry| {
            let marker = if entry.path == current {
                format!("{current_dot} ")
            } else {
                "  ".to_string()
            };
            format!(
                "{marker}{:<width$}  {}\t{}",
                entry.name(),
                entry.label(),
                entry.path,
                width = max_name_width
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn run_fzf(input: String, args: &[&str]) -> anyhow::Result<String> {
    let mut child = Command::new("fzf")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("fzf の起動に失敗しました")?;

    child
        .stdin
        .as_mut()
        .context("fzf の stdin を開けませんでした")?
        .write_all(input.as_bytes())
        .context("fzf への入力に失敗しました")?;

    let output = child
        .wait_with_output()
        .context("fzf の終了待ちに失敗しました")?;

    if !output.status.success() {
        std::process::exit(output.status.code().unwrap_or(1));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_worktree_porcelain() {
        let output = "\
worktree /repo/main
HEAD abcdef1234567890
branch refs/heads/main

worktree /repo/feature
HEAD 1234567890abcdef
branch refs/heads/feature/foo

worktree /repo/detached
HEAD fedcba9876543210
detached
";

        let entries = parse_worktree_porcelain(output);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "/repo/main");
        assert_eq!(entries[0].label(), "[main]");
        assert_eq!(entries[1].label(), "[feature/foo]");
        assert_eq!(entries[2].label(), "(fedcba9)");
    }

    #[test]
    fn test_format_worktree_rows() {
        let entries = vec![WorktreeEntry {
            path: "/repo/main".to_string(),
            head: Some("abcdef1234567890".to_string()),
            branch: Some("main".to_string()),
            is_bare: false,
            is_detached: false,
        }];

        let rows = format_worktree_rows(&entries, "/repo/main");

        assert!(rows.contains("main"));
        assert!(rows.contains("[main]"));
        assert!(rows.contains("\t/repo/main"));
    }
}
