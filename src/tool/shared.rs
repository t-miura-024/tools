use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context;

use crate::cli::style;

pub(super) struct Manifests {
    pub(super) root: PathBuf,
    pub(super) manifest_dir: PathBuf,
    pub(super) brewfile: PathBuf,
    pub(super) mise_toml: PathBuf,
    pub(super) npm_global: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ToolCommandSpec {
    pub(super) program: &'static str,
    pub(super) args: Vec<String>,
    pub(super) envs: Vec<(&'static str, &'static str)>,
}

impl ToolCommandSpec {
    pub(super) fn new(
        program: &'static str,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program,
            args: args.into_iter().map(Into::into).collect(),
            envs: Vec::new(),
        }
    }

    pub(super) fn with_env(mut self, key: &'static str, value: &'static str) -> Self {
        self.envs.push((key, value));
        self
    }
}

impl Manifests {
    pub(super) fn discover() -> anyhow::Result<Self> {
        let root = find_repo_root()?;
        let manifest_dir = root.join("manifests");
        Ok(Self {
            brewfile: manifest_dir.join("Brewfile"),
            mise_toml: manifest_dir.join("mise.toml"),
            npm_global: manifest_dir.join("npm-global.txt"),
            manifest_dir,
            root,
        })
    }

    pub(super) fn ensure_files(&self) -> anyhow::Result<()> {
        self.ensure_brewfile()?;
        ensure_file(&self.mise_toml, "mise.toml")?;
        ensure_file(&self.npm_global, "npm-global.txt")?;
        Ok(())
    }

    pub(super) fn ensure_brewfile(&self) -> anyhow::Result<()> {
        ensure_file(&self.brewfile, "Brewfile")
    }
}

fn ensure_file(path: &Path, name: &str) -> anyhow::Result<()> {
    if path.is_file() {
        style::success(&format!("{}: {}", name, path.display()));
        return Ok(());
    }

    anyhow::bail!("{} が見つかりません: {}", name, path.display());
}

pub(super) fn ensure_command(command: &str) -> anyhow::Result<()> {
    let status = Command::new(command)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if matches!(status, Ok(status) if status.success()) {
        style::success(&format!("{} コマンドを確認しました", command));
        return Ok(());
    }

    anyhow::bail!("{} コマンドが見つかりません", command);
}

pub(super) fn ensure_mise_trusted(root: &Path, mise_toml: &Path) -> anyhow::Result<()> {
    let output = command_output(
        "mise",
        &["trust", "--show", "--cd", root.to_string_lossy().as_ref()],
    )?;

    if output.contains("untrusted") {
        anyhow::bail!(
            "mise.toml が trust されていません。初回のみ `mise trust {}` を実行してください",
            mise_toml.display()
        );
    }

    style::success("mise.toml の trust 状態を確認しました");
    Ok(())
}

pub(super) fn read_npm_global_packages(path: &Path) -> anyhow::Result<Vec<String>> {
    let content = fs::read_to_string(path).with_context(|| {
        format!(
            "npm-global.txt の読み込みに失敗しました: {}",
            path.display()
        )
    })?;
    let mut seen = BTreeSet::new();
    let mut packages = Vec::new();

    for (index, line) in content.lines().enumerate() {
        let package = line.trim();
        if package.is_empty() || package.starts_with('#') {
            continue;
        }
        if package.split_whitespace().count() != 1 {
            anyhow::bail!(
                "npm-global.txt:{} は 1 行 1 パッケージで指定してください: {}",
                index + 1,
                line
            );
        }
        if seen.insert(package.to_string()) {
            packages.push(package.to_string());
        }
    }

    Ok(packages)
}

pub(super) fn npm_exec_prefix(manifest_dir: &Path) -> Vec<String> {
    vec![
        "exec".to_string(),
        "-C".to_string(),
        manifest_dir.to_string_lossy().to_string(),
        "--".to_string(),
    ]
}

pub(super) fn run_tool_command(
    command: &ToolCommandSpec,
    current_dir: &Path,
) -> anyhow::Result<()> {
    let status = run_tool_command_status(command, current_dir)?;

    if !status.success() {
        anyhow::bail!(
            "{} {} が失敗しました",
            command.program,
            command.args.join(" ")
        );
    }

    Ok(())
}

pub(super) fn run_tool_command_status(
    command: &ToolCommandSpec,
    current_dir: &Path,
) -> anyhow::Result<std::process::ExitStatus> {
    style::info(&format!(
        "実行: {} {}",
        command.program,
        command.args.join(" ")
    ));

    let mut command_builder = Command::new(command.program);
    command_builder.args(&command.args).current_dir(current_dir);
    for (key, value) in &command.envs {
        command_builder.env(key, value);
    }

    command_builder
        .status()
        .with_context(|| format!("{} の実行に失敗しました", command.program))
}

fn command_output(command: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .with_context(|| format!("{} の実行に失敗しました", command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{} が失敗しました: {}", command, stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub(super) fn command_output_spec(
    command: &ToolCommandSpec,
    current_dir: &Path,
) -> anyhow::Result<String> {
    let mut command_builder = Command::new(command.program);
    command_builder.args(&command.args).current_dir(current_dir);
    for (key, value) in &command.envs {
        command_builder.env(key, value);
    }

    let output = command_builder
        .output()
        .with_context(|| format!("{} の実行に失敗しました", command.program))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "{} {} が失敗しました: {}",
            command.program,
            command.args.join(" "),
            stderr.trim()
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn find_repo_root() -> anyhow::Result<PathBuf> {
    let current_dir = std::env::current_dir().context("カレントディレクトリを取得できません")?;

    if let Some(root) = find_manifest_root_from(&current_dir) {
        return Ok(root);
    }

    let build_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if build_root.join("Cargo.toml").is_file() {
        return Ok(build_root);
    }

    anyhow::bail!("mt リポジトリのルートを特定できませんでした");
}

fn find_manifest_root_from(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|dir| {
        if dir.join("Cargo.toml").is_file() && dir.join("src/main.rs").is_file() {
            Some(dir.to_path_buf())
        } else {
            None
        }
    })
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
