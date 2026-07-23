use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use dialoguer::Confirm;

use crate::cli::style;
use crate::git::common;

use super::entry;

pub fn create(no_push: bool) -> anyhow::Result<()> {
    common::ensure_inside_git_repo()?;
    style::intro("Git worktree 作成");

    let main_repo = resolve_main_repo_path()?;
    let parent_dir = main_repo
        .parent()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "main repo の親ディレクトリが取得できません: {}",
                main_repo.display()
            )
        })?
        .to_path_buf();
    let main_name = main_repo
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("main repo 名が取得できません: {}", main_repo.display()))?
        .to_string();

    let porcelain = common::command_output("git", &["worktree", "list", "--porcelain"])?;
    let entries = entry::parse_worktree_porcelain(&porcelain);

    let next_index = next_worktree_index(&entries, &parent_dir, &main_name);
    let new_name = format!("{main_name}-wt-{next_index}");
    let new_path = parent_dir.join(&new_name);

    if new_path.exists() {
        style::error(&format!(
            "ターゲットパスが既に存在します: {}",
            new_path.display()
        ));
        style::outro("中止しました");
        return Ok(());
    }

    let base = resolve_base_branch().unwrap_or_else(|_| "HEAD".to_string());
    let current_repo = common::command_output("git", &["rev-parse", "--show-toplevel"])?;
    let attach_to_existing = branch_exists(Path::new(&current_repo), &new_name);

    style::info(&format!("worktree パス: {}", new_path.display()));
    if attach_to_existing {
        style::info(&format!(
            "branch       : {new_name} (既存 branch に attach)"
        ));
    } else {
        style::info(&format!("新規 branch  : {new_name}"));
        style::info(&format!("派生元       : {base}"));
    }
    style::info(&format!(
        "push 設定    : {}",
        if no_push {
            "skip (--no-push)"
        } else {
            "origin へ push"
        }
    ));

    let confirm = Confirm::new()
        .with_prompt("この内容で作成しますか？")
        .default(true)
        .interact()?;

    if !confirm {
        style::outro("中止しました");
        return Ok(());
    }

    let spinner = style::spinner("worktree を作成中...");
    let result = if attach_to_existing {
        Command::new("git")
            .args(["worktree", "add"])
            .arg(&new_path)
            .arg(&new_name)
            .status()
    } else {
        Command::new("git")
            .args(["worktree", "add", "-b", &new_name])
            .arg(&new_path)
            .arg(&base)
            .status()
    };
    let worktree_created = match result {
        Ok(status) if status.success() => {
            spinner.finish_with_message("worktree を作成しました");
            true
        }
        Ok(_) => {
            spinner.finish_with_message("worktree の作成に失敗しました");
            style::error("git worktree add が失敗しました");
            style::outro("中止しました");
            false
        }
        Err(e) => {
            spinner.finish_with_message("worktree の作成に失敗しました");
            return Err(e).context("git worktree add の起動に失敗しました");
        }
    };

    if !worktree_created {
        return Ok(());
    }

    if no_push {
        style::outro(&format!(
            "✅ {} (push はスキップしました)",
            new_path.display()
        ));
        return Ok(());
    }

    match push_branch(&new_path, &new_name) {
        Ok(()) => {
            style::info(&format!("origin へ push: {new_name}"));
            style::outro(&format!("✅ {}", new_path.display()));
            Ok(())
        }
        Err(e) => {
            style::error(&format!(
                "push に失敗しました: {} (worktree は残っています)",
                e
            ));
            style::outro("⚠️ push 失敗 — 手動で git push を実行してください");
            std::process::exit(1);
        }
    }
}

fn push_branch(repo_path: &Path, branch: &str) -> anyhow::Result<()> {
    let Some(path_str) = repo_path.to_str() else {
        anyhow::bail!(
            "worktree パスが UTF-8 ではありません: {}",
            repo_path.display()
        );
    };
    let output = Command::new("git")
        .args(["-C", path_str, "push", "-u", "origin", branch])
        .output()
        .context("git push の起動に失敗しました")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git push: {}", stderr.trim());
    }
    Ok(())
}

fn resolve_main_repo_path() -> anyhow::Result<PathBuf> {
    let common_dir = common::command_output(
        "git",
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = PathBuf::from(common_dir);
    let main = common
        .parent()
        .ok_or_else(|| {
            anyhow::anyhow!("git common dir の親が取得できません: {}", common.display())
        })?
        .to_path_buf();
    Ok(main)
}

fn next_worktree_index(
    entries: &[entry::WorktreeEntry],
    parent_dir: &Path,
    repo_name: &str,
) -> usize {
    let prefix = format!("{repo_name}-wt-");
    entries
        .iter()
        .filter_map(|entry| {
            let path = Path::new(&entry.path);
            let parent = path.parent()?;
            if parent != parent_dir {
                return None;
            }
            let name = path.file_name()?.to_str()?;
            let suffix = name.strip_prefix(&prefix)?;
            suffix.parse::<usize>().ok()
        })
        .max()
        .map(|n| n + 1)
        .unwrap_or(1)
}

fn resolve_base_branch() -> anyhow::Result<String> {
    if let Ok(target) = common::command_output("git", &["symbolic-ref", "refs/remotes/origin/HEAD"])
        && let Some(short) = target.strip_prefix("refs/heads/")
    {
        return Ok(short.to_string());
    }
    if common::command_status("git", &["rev-parse", "--verify", "--quiet", "main"]) {
        return Ok("main".to_string());
    }
    if common::command_status("git", &["rev-parse", "--verify", "--quiet", "master"]) {
        return Ok("master".to_string());
    }
    bail!(
        "派生元の branch を特定できませんでした (origin/HEAD, main, master のいずれも見つかりません)"
    )
}

fn branch_exists(repo_path: &Path, branch: &str) -> bool {
    let Some(repo_str) = repo_path.to_str() else {
        return false;
    };
    common::command_status(
        "git",
        &[
            "-C",
            repo_str,
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
}

#[cfg(test)]
#[path = "create.test.rs"]
mod tests;
