use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context;

pub const EXPORT_DEEPLINK: &str =
    "raycast://extensions/raycast/raycast/export-settings-data";
pub const IMPORT_DEEPLINK: &str =
    "raycast://extensions/raycast/raycast/import-settings-data";

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

pub fn age_identity_path() -> PathBuf {
    let default = home_dir()
        .map(|h| h.join(".config/chezmoi/key.txt"))
        .unwrap_or_else(|_| PathBuf::from(".config/chezmoi/key.txt"));

    if let Ok(config_path) = home_dir()
        .map(|h| h.join(".config/chezmoi/chezmoi.toml"))
        && config_path.exists()
        && let Ok(content) = fs::read_to_string(&config_path)
    {
        for line in content.lines() {
            let line = line.trim();
            if let Some(path) = line.strip_prefix("identity = \"")
                .and_then(|s| s.strip_suffix('\"'))
            {
                let p = PathBuf::from(path);
                if p.exists() {
                    return p;
                }
            }
        }
    }

    default
}

pub fn raycast_app_present() -> bool {
    Path::new("/Applications/Raycast.app").exists()
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

    let identity = age_identity_path();
    if !identity.exists() {
        anyhow::bail!(
            "age 秘密鍵が見つかりません: {}\n\
             age-keygen -o ~/.config/chezmoi/key.txt で生成してください",
            identity.display()
        );
    }

    let output = Command::new("age")
        .args([
            "-d",
            "-i",
            &identity.to_string_lossy(),
            &passphrase_path.to_string_lossy(),
        ])
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

pub fn open_deeplink(url: &str) -> anyhow::Result<()> {
    let status = Command::new("open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("deeplink を開けませんでした: {}", url))?;

    if !status.success() {
        anyhow::bail!("open コマンドが失敗しました (exit code: {:?})", status.code());
    }
    Ok(())
}

pub fn find_latest_rayconfig_in_downloads() -> Option<PathBuf> {
    let downloads = home_dir()
        .ok()?
        .join("Downloads");

    let mut entries: Vec<_> = fs::read_dir(&downloads)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(".rayconfig")
        })
        .collect();

    entries.sort_by_key(|e| {
        e.metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    entries.reverse();

    entries.first().map(|e| e.path())
}

pub fn copy_file(src: &Path, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("ディレクトリを作成できません: {}", parent.display()))?;
    }
    fs::copy(src, dest)
        .with_context(|| {
            format!(
                "ファイルをコピーできません: {} -> {}",
                src.display(),
                dest.display()
            )
        })?;
    Ok(())
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
