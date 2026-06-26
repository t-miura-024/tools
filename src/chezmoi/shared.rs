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
