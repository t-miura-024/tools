use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context;

pub fn home_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    Ok(PathBuf::from(home))
}

pub fn chezmoi_source_dir() -> anyhow::Result<PathBuf> {
    if let Ok(dir) = std::env::var("CHEZMOI_SOURCE_DIR")
        && !dir.is_empty()
    {
        return Ok(PathBuf::from(dir));
    }
    Ok(home_dir()?.join("src/tools/chezmoi"))
}

pub fn rayconfig_path() -> anyhow::Result<PathBuf> {
    Ok(chezmoi_source_dir()?.join("dot_Raycast.rayconfig"))
}

pub fn passphrase_path() -> anyhow::Result<PathBuf> {
    Ok(chezmoi_source_dir()?.join("dot_raycast_passphrase.age"))
}

pub fn raycast_binary_present() -> bool {
    Command::new("raycast")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn age_binary_present() -> bool {
    Command::new("age")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn decrypt_passphrase(passphrase_path: &Path) -> anyhow::Result<zeroize::Zeroizing<String>> {
    if !passphrase_path.exists() {
        anyhow::bail!(
            "passphrase ファイルが見つかりません: {}\n\
             初回セットアップ:\n  \
               age-keygen -o ~/.config/chezmoi/key.txt\n  \
               printf '<passphrase>' | age -r <公開鍵> -o {}",
            passphrase_path.display(),
            passphrase_path.display()
        );
    }

    let output = Command::new("age")
        .args(["-d", &passphrase_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("age コマンドの起動に失敗")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("passphrase の復号に失敗: {}", stderr.trim());
    }

    let passphrase = String::from_utf8(output.stdout)
        .context("passphrase が有効な UTF-8 ではありません")?
        .trim()
        .to_string();

    Ok(zeroize::Zeroizing::new(passphrase))
}

pub fn run_raycast_export(passphrase: &str, output_path: &Path) -> anyhow::Result<()> {
    let status = Command::new("raycast")
        .args(["export", "--password", passphrase, "--output"])
        .arg(output_path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .context("raycast export の起動に失敗")?;

    if !status.success() {
        anyhow::bail!("raycast export が失敗しました (exit code: {:?})", status.code());
    }
    Ok(())
}

pub fn run_raycast_import(passphrase: &str, input_path: &Path) -> anyhow::Result<()> {
    let status = Command::new("raycast")
        .args(["import", "--password", passphrase, "--input"])
        .arg(input_path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .context("raycast import の起動に失敗")?;

    if !status.success() {
        anyhow::bail!("raycast import が失敗しました (exit code: {:?})", status.code());
    }
    Ok(())
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
