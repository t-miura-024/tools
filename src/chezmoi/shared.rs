use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;

/// Resolve the chezmoi source directory.
///
/// 1. If `CHEZMOI_SOURCE_DIR` env var is set, use it (passed as `-S` to chezmoi).
/// 2. Otherwise, fall back to the chezmoi config's `sourceDir` if available.
/// 3. Otherwise, return the default `~/src/tools/chezmoi`.
///
/// When the env var is set, callers should pass `-S` to chezmoi so that the
/// override applies even when `~/.config/chezmoi/chezmoi.toml` has a different
/// `sourceDir`.
pub fn resolve_source_dir() -> Option<String> {
    if let Ok(dir) = std::env::var("CHEZMOI_SOURCE_DIR")
        && !dir.is_empty()
    {
        return Some(dir);
    }
    None
}

/// Resolve the chezmoi source directory with full fallback chain.
///
/// 1. `CHEZMOI_SOURCE_DIR` env var
/// 2. `sourceDir` from `~/.config/chezmoi/chezmoi.toml`
/// 3. Default `~/src/tools/chezmoi`
pub fn resolve_chezmoi_source_dir() -> anyhow::Result<PathBuf> {
    if let Ok(dir) = std::env::var("CHEZMOI_SOURCE_DIR")
        && !dir.is_empty()
    {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = parse_chezmoi_toml_source_dir() {
        return Ok(dir);
    }
    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    Ok(PathBuf::from(format!("{}/src/tools/chezmoi", home)))
}

/// Parse `sourceDir` from `~/.config/chezmoi/chezmoi.toml`.
pub fn parse_chezmoi_toml_source_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let config_path = PathBuf::from(format!("{}/.config/chezmoi/chezmoi.toml", home));
    let content = std::fs::read_to_string(&config_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("sourceDir") {
            let value = value
                .trim_start()
                .strip_prefix('=')?
                .trim()
                .trim_matches('"');
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// Validate that `key` is a legal shell environment variable name.
pub fn validate_env_key_name(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("KEY が空です".to_string());
    }
    let first = key.chars().next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return Err(format!(
            "KEY の先頭文字が無効です '{}': 英字または '_' で始めてください",
            first
        ));
    }
    for (i, c) in key.chars().enumerate() {
        if !c.is_ascii_alphanumeric() && c != '_' {
            return Err(format!(
                "KEY の {} 文字目 '{}' が無効です: 英数字と '_' のみ使用できます",
                i + 1,
                c
            ));
        }
    }
    Ok(())
}

/// Fixed header for the secrets file format.
pub const SECRETS_HEADER: &str = "# Secrets（chezmoi で age 暗号化）";

/// Parse `export KEY=VALUE` lines in order (first occurrence wins for duplicates).
pub fn parse_export_entries(plaintext: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for line in plaintext.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("export ") else {
            continue;
        };
        let Some((name, value)) = rest.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || validate_env_key_name(name).is_err() {
            continue;
        }
        if entries.iter().any(|(k, _)| k == name) {
            continue;
        }
        entries.push((name.to_string(), value.to_string()));
    }
    entries
}

/// Normalize secrets plaintext to the canonical format:
///
/// ```text
/// # Secrets（chezmoi で age 暗号化）
/// export KEY1=value1
/// export KEY2=value2
/// ```
pub fn normalize_secrets_plaintext(entries: &[(String, String)]) -> String {
    let mut out = String::from(SECRETS_HEADER);
    out.push('\n');
    for (key, value) in entries {
        out.push_str("export ");
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

/// Set or update a secret key, returning normalized plaintext.
pub fn set_secret_entry(plaintext: &str, key: &str, value: &str) -> String {
    let mut entries = parse_export_entries(plaintext);
    if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| k == key) {
        *existing = value.to_string();
    } else {
        entries.push((key.to_string(), value.to_string()));
    }
    normalize_secrets_plaintext(&entries)
}

/// Delete a secret key, returning normalized plaintext (header only if empty).
pub fn delete_secret_entry(plaintext: &str, key: &str) -> String {
    let entries: Vec<(String, String)> = parse_export_entries(plaintext)
        .into_iter()
        .filter(|(k, _)| k != key)
        .collect();
    normalize_secrets_plaintext(&entries)
}

/// Check whether `key` exists as an export line in the plaintext content.
pub fn key_exists_in_plaintext(plaintext: &str, key: &str) -> bool {
    parse_export_entries(plaintext)
        .iter()
        .any(|(k, _)| k == key)
}

/// List environment variable keys found as `export KEY=` lines.
pub fn list_keys_in_plaintext(plaintext: &str) -> Vec<String> {
    parse_export_entries(plaintext)
        .into_iter()
        .map(|(k, _)| k)
        .collect()
}

/// Default chezmoi source dir, used when no env var is set and we want to
/// surface the expected location in help/error messages.
#[allow(dead_code)]
pub fn default_source_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{}/src/tools/chezmoi", home)
}

/// Build a `chezmoi` command. If the env var override is set, the explicit
/// `-S` flag is appended to ensure chezmoi uses the overridden source dir.
pub fn build_chezmoi_command(args: &[&str]) -> Command {
    let mut cmd = Command::new("chezmoi");
    cmd.args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if let Some(source) = resolve_source_dir() {
        cmd.args(["--source", &source]);
    }

    cmd
}

/// Run a chezmoi subcommand, inheriting stdio and propagating the exit code.
pub fn run_chezmoi(args: &[&str]) -> anyhow::Result<()> {
    let mut cmd = build_chezmoi_command(args);
    let status = cmd
        .status()
        .with_context(|| "chezmoi の起動に失敗しました".to_string())?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

/// Check whether the `chezmoi` binary is on PATH.
pub fn chezmoi_binary_present() -> bool {
    Command::new("chezmoi")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Return the home directory as `PathBuf`, falling back to an error.
pub fn home_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    Ok(PathBuf::from(home))
}

/// Process-wide mutex for serializing tests that mutate environment variables.
/// `cargo test` runs tests in parallel by default, and env vars are shared
/// across the entire process, so tests in different test files (which run in
/// separate binaries but compete for the same env vars) can race.
#[cfg(test)]
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
