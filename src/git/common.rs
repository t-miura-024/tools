use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, bail};

pub fn ensure_inside_git_repo() -> anyhow::Result<()> {
    ensure_inside_git_repo_in(&std::env::current_dir()?)
}

pub fn ensure_inside_git_repo_in(cwd: &Path) -> anyhow::Result<()> {
    let status = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("git の実行に失敗しました")?;

    if !status.success() {
        bail!("Not inside a git repository.");
    }

    Ok(())
}

pub fn command_output(command: &str, args: &[&str]) -> anyhow::Result<String> {
    command_output_in(&std::env::current_dir()?, command, args)
}

pub fn command_output_in(cwd: &Path, command: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("{command} の実行に失敗しました"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{command} が失敗しました: {}", stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub fn command_status(command: &str, args: &[&str]) -> bool {
    command_status_in(
        &std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf()),
        command,
        args,
    )
}

pub fn command_status_in(cwd: &Path, command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn ensure_fzf_present() -> bool {
    command_status("fzf", &["--version"])
}

pub fn run_fzf(input: String, args: &[&str]) -> anyhow::Result<String> {
    let mut child = Command::new("fzf")
        .env_remove("FZF_DEFAULT_OPTS")
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

pub fn current_branch() -> anyhow::Result<String> {
    current_branch_in(&std::env::current_dir()?)
}

pub fn current_branch_in(cwd: &Path) -> anyhow::Result<String> {
    let branch = command_output_in(cwd, "git", &["branch", "--show-current"])
        .context("現在のブランチを取得できませんでした")?;
    if branch.is_empty() {
        bail!("detached HEAD です。branch に切り替えてから実行してください");
    }
    Ok(branch)
}

pub fn is_protected_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master")
}

pub fn local_branches() -> anyhow::Result<Vec<String>> {
    local_branches_in(&std::env::current_dir()?)
}

pub fn local_branches_in(cwd: &Path) -> anyhow::Result<Vec<String>> {
    let output = command_output_in(cwd, "git", &["branch", "--format=%(refname:short)"])
        .context("ローカルブランチ一覧を取得できませんでした")?;
    Ok(output
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

pub fn resolve_default_branch() -> anyhow::Result<String> {
    resolve_default_branch_in(&std::env::current_dir()?)
}

pub fn resolve_default_branch_in(cwd: &Path) -> anyhow::Result<String> {
    if let Ok(target) = command_output_in(
        cwd,
        "git",
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) && !target.is_empty()
    {
        // `git symbolic-ref --short refs/remotes/origin/HEAD` は
        // `refs/remotes/` を除くが `origin/` は残るため、純粋なブランチ名に揃える
        let stripped = target.trim_start_matches("origin/");
        return Ok(stripped.to_string());
    }

    if let Ok(remote_show) = command_output_in(cwd, "git", &["remote", "show", "origin"]) {
        for line in remote_show.lines() {
            if let Some(branch) = line.trim().strip_prefix("HEAD branch:") {
                let branch = branch.trim();
                if !branch.is_empty() {
                    return Ok(branch.to_string());
                }
            }
        }
    }

    if command_status_in(cwd, "git", &["rev-parse", "--verify", "--quiet", "main"]) {
        return Ok("main".to_string());
    }
    if command_status_in(cwd, "git", &["rev-parse", "--verify", "--quiet", "master"]) {
        return Ok("master".to_string());
    }

    bail!(
        "デフォルトブランチを特定できませんでした (origin/HEAD, remote show, main, master のいずれも見つかりません)"
    )
}

pub fn format_branches_for_fzf(branches: &[String], default: &str) -> String {
    let mut sorted: Vec<&str> = branches.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| {
        if *a == default && *b != default {
            std::cmp::Ordering::Less
        } else if *b == default && *a != default {
            std::cmp::Ordering::Greater
        } else {
            a.cmp(b)
        }
    });
    sorted.join("\n") + "\n"
}

pub fn select_branch_via_fzf(branches: &[String], default: &str) -> anyhow::Result<String> {
    let input = format_branches_for_fzf(branches, default);
    let selected = run_fzf(
        input,
        &["--ansi", "--query", default, "--prompt", "target branch> "],
    )?;
    Ok(selected.trim().to_string())
}

pub fn resolve_target_branch(target: Option<String>) -> anyhow::Result<String> {
    if let Some(t) = target {
        if t.is_empty() {
            bail!("--target に空文字を指定できません");
        }
        return Ok(t);
    }

    let default = resolve_default_branch()?;
    let branches = local_branches()?;

    if ensure_fzf_present() {
        select_branch_via_fzf(&branches, &default)
    } else {
        Ok(default)
    }
}

pub fn snapshot_git_state() -> String {
    snapshot_git_state_in(&std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf()))
}

pub fn snapshot_git_state_in(cwd: &Path) -> String {
    let mut lines = Vec::new();

    if let Ok(branch) = current_branch_in(cwd) {
        lines.push(format!("現在のブランチ: {branch}"));
    }
    if let Ok(head) = command_output_in(cwd, "git", &["rev-parse", "--short", "HEAD"]) {
        lines.push(format!("HEAD: {head}"));
    }
    if let Ok(status) = command_output_in(cwd, "git", &["status", "--porcelain"]) {
        if status.is_empty() {
            lines.push("作業ツリー: クリーン".to_string());
        } else {
            lines.push(format!("未コミット変更:\n{status}"));
        }
    }
    if let Ok(stash) = command_output_in(cwd, "git", &["stash", "list"])
        && !stash.is_empty()
    {
        lines.push(format!("stash 一覧:\n{stash}"));
    }

    lines.join("\n")
}

pub fn worktree_has_uncommitted_changes(path: &Path) -> bool {
    let status = command_output_in(path, "git", &["status", "--porcelain"])
        .unwrap_or_default();
    !status.is_empty()
}

pub fn generate_commit_message(shortstat: &str) -> String {
    use regex::Regex;

    let trimmed = shortstat.trim();
    if trimmed.is_empty() {
        return "update: workspace changes".to_string();
    }

    let files_re = Regex::new(r"(\d+) files? changed").unwrap();
    let ins_re = Regex::new(r"(\d+) insertions?\(\+\)").unwrap();
    let del_re = Regex::new(r"(\d+) deletions?\(-\)").unwrap();

    let parse = |re: &Regex, s: &str| -> usize {
        re.captures(s)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<usize>().ok())
            .unwrap_or(0)
    };

    let files = parse(&files_re, trimmed);
    let insertions = parse(&ins_re, trimmed);
    let deletions = parse(&del_re, trimmed);

    if files == 0 && insertions == 0 && deletions == 0 {
        return "update: workspace changes".to_string();
    }
    format!("update: {files} files changed (+{insertions} -{deletions})")
}

#[cfg(test)]
#[path = "common.test.rs"]
mod tests;
