use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context;
use dialoguer::Confirm;

use crate::cli::style;
use crate::git::common;

use super::pick;

pub fn delete(force: bool) -> anyhow::Result<()> {
    common::ensure_inside_git_repo()?;
    common::ensure_fzf_available()?;

    style::intro("Git worktree 削除");

    let picked = pick::pick_worktree("delete> ")?;
    let target = picked.target;
    let target_path = PathBuf::from(&target);
    let is_current = picked.is_current;

    if is_current {
        style::warn("現在の作業ディレクトリの worktree を削除します");
    }

    if !force {
        let issues = check_worktree_safety(&target_path)?;
        for issue in &issues {
            let proceed = Confirm::new()
                .with_prompt(format!("{} - 続行しますか？", issue.message()))
                .default(false)
                .interact()?;
            if !proceed {
                style::outro("中止しました");
                return Ok(());
            }
        }

        let final_confirm = Confirm::new()
            .with_prompt(format!("worktree を削除します: {target}\nよろしいですか？"))
            .default(false)
            .interact()?;

        if !final_confirm {
            style::outro("中止しました");
            return Ok(());
        }
    }

    if is_current && let Some(parent) = target_path.parent() {
        std::env::set_current_dir(parent).with_context(|| {
            format!(
                "現在のディレクトリの変更に失敗しました: {}",
                parent.display()
            )
        })?;
    }

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&target);

    let spinner = style::spinner("worktree を削除中...");
    let result = Command::new("git").args(&args).status();
    match result {
        Ok(status) if status.success() => {
            spinner.finish_with_message("worktree を削除しました");
            println!();
            style::info(&format_recovery_hints(&target_path));
            style::outro("✅ 削除完了");
        }
        Ok(_) => {
            spinner.finish_with_message("worktree の削除に失敗しました");
            style::error("git worktree remove が失敗しました");
            style::outro("中止しました");
        }
        Err(e) => {
            spinner.finish_with_message("worktree の削除に失敗しました");
            return Err(e).context("git worktree remove の起動に失敗しました");
        }
    }

    Ok(())
}

#[derive(Debug)]
struct SafetyIssue {
    kind: SafetyKind,
    detail: String,
}

#[derive(Debug)]
enum SafetyKind {
    Uncommitted,
    Unpushed,
    Unmerged,
}

impl SafetyIssue {
    fn message(&self) -> String {
        match self.kind {
            SafetyKind::Uncommitted => format!("未コミットの変更があります ({})", self.detail),
            SafetyKind::Unpushed => format!("未 push の commit があります ({})", self.detail),
            SafetyKind::Unmerged => format!("未マージの branch です ({})", self.detail),
        }
    }
}

fn check_worktree_safety(path: &Path) -> anyhow::Result<Vec<SafetyIssue>> {
    let mut issues = Vec::new();
    let Some(path_str) = path.to_str() else {
        return Ok(issues);
    };

    if let Ok(out) = common::command_output("git", &["-C", path_str, "status", "--porcelain"])
        && !out.is_empty()
    {
        let count = out.lines().count();
        issues.push(SafetyIssue {
            kind: SafetyKind::Uncommitted,
            detail: format!("{count} ファイル"),
        });
    }

    if let Ok(upstream) = common::command_output(
        "git",
        &[
            "-C",
            path_str,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
    ) {
        let upstream = upstream.trim().to_string();
        if !upstream.is_empty() {
            let range = format!("{upstream}..HEAD");
            if let Ok(commits) =
                common::command_output("git", &["-C", path_str, "log", "--oneline", &range])
                && !commits.is_empty()
            {
                let count = commits.lines().count();
                issues.push(SafetyIssue {
                    kind: SafetyKind::Unpushed,
                    detail: format!("{count} commits ({upstream})"),
                });
            }
        }
    }

    if let Ok(branch) = common::command_output(
        "git",
        &["-C", path_str, "rev-parse", "--abbrev-ref", "HEAD"],
    ) {
        let branch = branch.trim();
        if !branch.is_empty() && branch != "HEAD" {
            for base in ["main", "master"] {
                if branch == base {
                    continue;
                }
                if common::command_status(
                    "git",
                    &["-C", path_str, "rev-parse", "--verify", "--quiet", base],
                ) {
                    let merged = Command::new("git")
                        .args(["-C", path_str, "merge-base", "--is-ancestor", branch, base])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    if !merged {
                        issues.push(SafetyIssue {
                            kind: SafetyKind::Unmerged,
                            detail: format!("{branch} が {base} に未マージ"),
                        });
                    }
                    break;
                }
            }
        }
    }

    Ok(issues)
}

fn format_recovery_hints(deleted_path: &Path) -> String {
    let name = deleted_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("worktree");
    format!(
        "復旧ヒント:\n\
         - worktree 登録の掃除: git worktree prune\n\
         - 削除した branch の復元: git reflog | grep '{name}' で commit を確認し、git branch <name> <sha> で復元\n\
         - detached HEAD だった場合: git checkout <sha> で参照可能"
    )
}

#[cfg(test)]
#[path = "delete.test.rs"]
mod tests;
