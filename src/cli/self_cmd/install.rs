use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;

use crate::chezmoi::shared::{chezmoi_binary_present, resolve_source_dir};
use crate::cli::style;

pub fn run() -> anyhow::Result<()> {
    style::intro("mt self install");

    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    let repo_root = PathBuf::from(format!("{}/src/tools", home));

    ensure_chezmoi_binary();
    run_chezmoi_apply()?;
    install_via_cargo(&repo_root)?;

    style::outro("セットアップが完了しました");
    Ok(())
}

fn ensure_chezmoi_binary() {
    if chezmoi_binary_present() {
        style::success("chezmoi バイナリ: 検出");
    } else {
        style::warn(
            "chezmoi バイナリが見つかりません。`mt tool install` を先に実行して chezmoi を導入してください",
        );
    }
}

fn run_chezmoi_apply() -> anyhow::Result<()> {
    let mut cmd = Command::new("chezmoi");
    cmd.arg("apply")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if let Some(source) = resolve_source_dir() {
        cmd.args(["--source", &source]);
    }

    let status = match cmd.status() {
        Ok(status) => status,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            style::warn("chezmoi バイナリが見つからないため apply をスキップしました");
            return Ok(());
        }
        Err(err) => {
            return Err(err).context("chezmoi apply の起動に失敗しました");
        }
    };

    if !status.success() {
        anyhow::bail!("chezmoi apply が失敗しました");
    }

    style::success("chezmoi apply 完了");
    Ok(())
}

fn install_via_cargo(repo_root: &PathBuf) -> anyhow::Result<()> {
    if !repo_root.join("Cargo.toml").is_file() {
        anyhow::bail!(
            "{} に Cargo.toml が見つかりません。mt のソースリポジトリを {} に配置してください",
            repo_root.display(),
            repo_root.display()
        );
    }

    style::info(&format!(
        "実行: cargo install --path {}",
        repo_root.display()
    ));

    let mut command = Command::new("cargo");
    command
        .arg("install")
        .arg("--path")
        .arg(repo_root)
        .current_dir(repo_root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = match command.status() {
        Ok(status) => status,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            style::warn(
                "cargo コマンドが見つかりません。`mt tool install` を先に実行して mise で Rust を導入してください",
            );
            return Ok(());
        }
        Err(err) => {
            return Err(err).context("cargo install の起動に失敗しました");
        }
    };

    if !status.success() {
        anyhow::bail!("cargo install が失敗しました");
    }

    style::success("cargo install が完了しました（~/.cargo/bin/mt に配置されました）");
    Ok(())
}

#[cfg(test)]
#[path = "install.test.rs"]
mod tests;
