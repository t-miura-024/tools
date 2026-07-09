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
            let value = value.trim_start().strip_prefix('=')?.trim().trim_matches('"');
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

/// Build a secret block header line using JST timestamp.
pub fn build_secret_block_header(key: &str, timestamp: &str) -> String {
    format!("# {}（{}）", key, timestamp)
}

/// Append a secret block to existing plaintext with one blank line between blocks.
pub fn append_secret_block(plaintext: &str, block: &str) -> String {
    let mut s = plaintext.trim_end().to_string();
    if !s.is_empty() {
        s.push_str("\n\n");
    }
    s.push_str(block);
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Check whether `key` exists as an export line in the plaintext content.
pub fn key_exists_in_plaintext(plaintext: &str, key: &str) -> bool {
    let prefix = format!("export {}=", key);
    plaintext.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with(&prefix)
    })
}

/// List environment variable keys found as `export KEY=` lines.
pub fn list_keys_in_plaintext(plaintext: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in plaintext.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("export ") else {
            continue;
        };
        let Some((name, _)) = rest.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || validate_env_key_name(name).is_err() {
            continue;
        }
        if !keys.iter().any(|k| k == name) {
            keys.push(name.to_string());
        }
    }
    keys
}

/// Remove an existing secret block for `key` from the plaintext.
///
/// A block consists of an optional comment line `# KEY（...）` followed by
/// optional blank lines and an `export KEY=...` line.  Leading/trailing
/// whitespace around the block is trimmed.
pub fn remove_existing_block(plaintext: &str, key: &str) -> String {
    let export_prefix = format!("export {}=", key);
    let comment_prefix = format!("# {}", key);
    let lines: Vec<&str> = plaintext.lines().collect();
    let mut result: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        // Detect block start: comment line that matches the key
        if line.trim_start().starts_with(&comment_prefix) {
            // Skip comment line and any following blank lines
            i += 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            // Skip the export line if it matches
            if i < lines.len() && lines[i].trim().starts_with(&export_prefix) {
                i += 1;
            }
            // Skip trailing blank lines after the block
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        // Also detect standalone export line (without comment header)
        if line.trim().starts_with(&export_prefix) {
            // Look back to remove preceding blank lines and comment header
            while result.last().is_some_and(|l| l.trim().is_empty()) {
                result.pop();
            }
            if result.last().is_some_and(|l| l.trim_start().starts_with(&comment_prefix)) {
                result.pop();
            }
            i += 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        result.push(line);
        i += 1;
    }
    // Trim trailing empty lines
    while result.last().is_some_and(|l| l.trim().is_empty()) {
        result.pop();
    }
    result.join("\n") + "\n"
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
