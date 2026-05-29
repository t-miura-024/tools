use std::fs;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, bail};
use dialoguer::{Input, Select};

use crate::cli::style;
use crate::config;

pub fn create() -> anyhow::Result<()> {
    style::intro("GitHub リポジトリ作成");

    let name: String = Input::new()
        .with_prompt("リポジトリ名")
        .validate_with(|input: &String| -> Result<(), &str> {
            if input.is_empty() {
                return Err("リポジトリ名を入力してください");
            }
            if !input
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
            {
                return Err("リポジトリ名に使える文字: a-z, 0-9, _, ., -");
            }
            Ok(())
        })
        .interact_text()?;

    let placements = ["~/src", "~/doc"];
    let placement_idx = Select::new()
        .with_prompt("配置先")
        .items(&placements)
        .default(0)
        .interact()?;
    let placement = if placement_idx == 0 { "src" } else { "doc" };

    let visibility_options = ["Private", "Public"];
    let vis_idx = Select::new()
        .with_prompt("公開設定")
        .items(&visibility_options)
        .default(0)
        .interact()?;
    let visibility = if vis_idx == 0 { "private" } else { "public" };

    let description: String = Input::new()
        .with_prompt("説明 (省略可)")
        .allow_empty(true)
        .interact_text()?;

    let dir = config::home_dir().join(placement).join(&name);

    if dir.exists() {
        style::error(&format!("ディレクトリが既に存在します: {}", dir.display()));
        style::outro("中止しました");
        return Ok(());
    }

    if !check_gh_auth()? {
        style::error("gh CLI が認証されていません。\n  gh auth login を実行してください");
        style::outro("中止しました");
        return Ok(());
    }

    let spinner = style::spinner("ローカルリポジトリをセットアップ中...");
    match setup_local_repo(&dir, &name) {
        Ok(()) => {
            spinner.finish_with_message("ローカルセットアップ完了");
        }
        Err(e) => {
            spinner.finish_with_message("ローカルセットアップ失敗");
            style::error(&e.to_string());
            style::outro("中止しました");
            return Ok(());
        }
    }

    accept_github_host_key()?;

    let spinner = style::spinner("GitHub リポジトリを作成・push 中...");
    match create_github_repo(&name, visibility, &description, &dir) {
        Ok(()) => {
            spinner.finish_with_message("GitHub リポジトリを作成しました");
        }
        Err(e) => {
            spinner.finish_with_message("GitHub リポジトリ作成失敗");
            style::error(&e.to_string());
            style::outro("中止しました");
            return Ok(());
        }
    }

    style::outro(&format!("✅ {} を作成しました: {}", name, dir.display()));
    Ok(())
}

fn check_gh_auth() -> anyhow::Result<bool> {
    let status = Command::new("gh")
        .args(["auth", "status"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context("gh コマンドの実行に失敗しました")?;
    Ok(status.success())
}

fn setup_local_repo(dir: &PathBuf, _name: &str) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;

    let status = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git init に失敗しました");
    }

    fs::write(dir.join("README.md"), format!("# {}\n", _name))?;
    fs::write(dir.join(".gitignore"), "")?;

    let status = Command::new("git")
        .args(["add", "."])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git add に失敗しました");
    }

    let status = Command::new("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git commit に失敗しました");
    }

    Ok(())
}

fn accept_github_host_key() -> anyhow::Result<()> {
    let _ = Command::new("ssh")
        .args([
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-T",
            "git@github.com",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    Ok(())
}

fn create_github_repo(
    name: &str,
    visibility: &str,
    description: &str,
    dir: &PathBuf,
) -> anyhow::Result<()> {
    let vis_flag = format!("--{}", visibility);
    let mut args = vec![
        "repo",
        "create",
        name,
        &vis_flag[..],
        "--source=.",
        "--push",
    ];
    if !description.is_empty() {
        args.push("--description");
        args.push(description);
    }

    let status = Command::new("gh").args(&args).current_dir(dir).status()?;
    if !status.success() {
        bail!("gh repo create に失敗しました");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_repo_name_validation() {
        let valid_names = ["my-repo", "my.repo", "my_repo", "repo123", "a.b-c_d"];
        for name in &valid_names {
            assert!(
                name.chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
                "{} should be valid",
                name
            );
        }

        let invalid_names = ["my repo", "repo/name", "repo!name"];
        for name in &invalid_names {
            assert!(
                !name
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
                "{} should be invalid",
                name
            );
        }
    }
}
