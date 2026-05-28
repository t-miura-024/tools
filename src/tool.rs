use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Context;
use clap::Subcommand;
use dialoguer::Confirm;

use crate::cli::style;

#[derive(Subcommand)]
pub enum ToolCommands {
    /// Install tools from repository manifests
    Install,
    /// Verify Homebrew and mise tool manifests
    Verify,
    /// Homebrew operations
    #[command(subcommand)]
    Brew(ToolBrewCommands),
}

#[derive(Subcommand)]
pub enum ToolBrewCommands {
    /// Upgrade installed Homebrew packages
    Upgrade,
}

pub fn run(cmd: ToolCommands) -> anyhow::Result<()> {
    match cmd {
        ToolCommands::Install => install(),
        ToolCommands::Verify => verify(),
        ToolCommands::Brew(sub) => match sub {
            ToolBrewCommands::Upgrade => brew_upgrade(),
        },
    }
}

fn install() -> anyhow::Result<()> {
    style::intro("ツールインストール");

    let manifests = Manifests::discover()?;
    manifests.ensure_files()?;
    ensure_command("brew")?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;
    let npm_packages = read_npm_global_packages(&manifests.npm_global)?;

    run_tool_command(
        &brew_bundle_install_command(&manifests.brewfile),
        &manifests.root,
    )?;
    run_tool_command(
        &mise_install_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    if !npm_packages.is_empty() {
        run_tool_command(
            &npm_global_install_command(&manifests.manifest_dir, &npm_packages),
            &manifests.root,
        )?;
        run_tool_command(
            &mise_reshim_command(&manifests.manifest_dir),
            &manifests.root,
        )?;
    }
    cleanup_after_install(&manifests, &npm_packages)?;

    style::outro("✅ ツールのインストールが完了しました");
    Ok(())
}

fn verify() -> anyhow::Result<()> {
    style::intro("ツール管理の検証");

    let manifests = Manifests::discover()?;
    manifests.ensure_files()?;
    ensure_command("brew")?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;
    let npm_packages = read_npm_global_packages(&manifests.npm_global)?;

    run_tool_command(
        &brew_bundle_check_command(&manifests.brewfile),
        &manifests.root,
    )?;
    run_tool_command(
        &mise_verify_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    if !npm_packages.is_empty() {
        run_tool_command(
            &npm_global_verify_command(&manifests.manifest_dir, &npm_packages),
            &manifests.root,
        )?;
    }

    style::outro("✅ ツール管理の検証が完了しました");
    Ok(())
}

fn brew_upgrade() -> anyhow::Result<()> {
    style::intro("Homebrew パッケージ更新");

    let manifests = Manifests::discover()?;
    manifests.ensure_brewfile()?;
    ensure_command("brew")?;

    for command in brew_upgrade_commands() {
        run_tool_command(&command, &manifests.root)?;
    }

    style::outro("✅ Homebrew パッケージの更新が完了しました");
    Ok(())
}

fn cleanup_after_install(manifests: &Manifests, npm_packages: &[String]) -> anyhow::Result<()> {
    run_cleanup_preview(
        "Brewfile 管理対象外の依存",
        &brew_bundle_cleanup_preview_command(&manifests.brewfile),
        &brew_bundle_cleanup_force_command(&manifests.brewfile),
        &manifests.root,
    )?;
    run_cleanup_preview(
        "mise",
        &mise_prune_preview_command(&manifests.manifest_dir),
        &mise_prune_tools_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    cleanup_npm_globals(manifests, npm_packages)?;

    Ok(())
}

fn run_cleanup_preview(
    label: &str,
    preview_command: &ToolCommandSpec,
    force_command: &ToolCommandSpec,
    current_dir: &Path,
) -> anyhow::Result<()> {
    style::info(&format!("{label} の削除候補を確認します"));
    let status = run_tool_command_status(preview_command, current_dir)?;

    if status.success() {
        style::success(&format!("{label} の削除候補はありません"));
        return Ok(());
    }

    if status.code() != Some(1) {
        anyhow::bail!("{label} の削除候補確認に失敗しました");
    }

    let cleanup = Confirm::new()
        .with_prompt(format!("{label} の削除候補があります。削除しますか？"))
        .default(false)
        .interact()?;

    if cleanup {
        run_tool_command(force_command, current_dir)?;
    } else {
        style::info(&format!("{label} の削除はスキップしました"));
    }

    Ok(())
}

fn cleanup_npm_globals(manifests: &Manifests, desired_packages: &[String]) -> anyhow::Result<()> {
    style::info("npm global の削除候補を確認します");
    let installed_packages =
        installed_npm_global_packages(&manifests.manifest_dir, &manifests.root)?;
    let removable = removable_npm_global_packages(&installed_packages, desired_packages);

    if removable.is_empty() {
        style::success("npm global の削除候補はありません");
        return Ok(());
    }

    for package in &removable {
        style::info(&format!("削除候補: npm global {}", package));
    }

    let cleanup = Confirm::new()
        .with_prompt("npm global の削除候補があります。削除しますか？")
        .default(false)
        .interact()?;

    if cleanup {
        run_tool_command(
            &npm_global_uninstall_command(&manifests.manifest_dir, &removable),
            &manifests.root,
        )?;
        run_tool_command(
            &mise_reshim_command(&manifests.manifest_dir),
            &manifests.root,
        )?;
    } else {
        style::info("npm global の削除はスキップしました");
    }

    Ok(())
}

fn read_npm_global_packages(path: &Path) -> anyhow::Result<Vec<String>> {
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

fn removable_npm_global_packages(installed: &[String], desired: &[String]) -> Vec<String> {
    let desired: BTreeSet<&str> = desired.iter().map(String::as_str).collect();
    let protected: BTreeSet<&str> = ["npm", "corepack"].into_iter().collect();

    installed
        .iter()
        .filter(|package| !desired.contains(package.as_str()))
        .filter(|package| !protected.contains(package.as_str()))
        .cloned()
        .collect()
}

fn installed_npm_global_packages(
    manifest_dir: &Path,
    current_dir: &Path,
) -> anyhow::Result<Vec<String>> {
    let output = command_output_spec(&npm_global_list_command(manifest_dir), current_dir)?;
    let json: serde_json::Value = serde_json::from_str(&output)?;
    let packages = json
        .get("dependencies")
        .and_then(|dependencies| dependencies.as_object())
        .map(|dependencies| dependencies.keys().cloned().collect())
        .unwrap_or_default();

    Ok(packages)
}

struct Manifests {
    root: PathBuf,
    manifest_dir: PathBuf,
    brewfile: PathBuf,
    mise_toml: PathBuf,
    npm_global: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct ToolCommandSpec {
    program: &'static str,
    args: Vec<String>,
    envs: Vec<(&'static str, &'static str)>,
}

impl ToolCommandSpec {
    fn new(program: &'static str, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            program,
            args: args.into_iter().map(Into::into).collect(),
            envs: Vec::new(),
        }
    }

    fn with_env(mut self, key: &'static str, value: &'static str) -> Self {
        self.envs.push((key, value));
        self
    }
}

impl Manifests {
    fn discover() -> anyhow::Result<Self> {
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

    fn ensure_files(&self) -> anyhow::Result<()> {
        self.ensure_brewfile()?;
        ensure_file(&self.mise_toml, "mise.toml")?;
        ensure_file(&self.npm_global, "npm-global.txt")?;
        Ok(())
    }

    fn ensure_brewfile(&self) -> anyhow::Result<()> {
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

fn ensure_command(command: &str) -> anyhow::Result<()> {
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

fn ensure_mise_trusted(root: &Path, mise_toml: &Path) -> anyhow::Result<()> {
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

fn brew_bundle_install_command(brewfile: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "brew",
        [
            "bundle".to_string(),
            "install".to_string(),
            "--file".to_string(),
            brewfile.to_string_lossy().to_string(),
        ],
    )
}

fn brew_bundle_check_command(brewfile: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "brew",
        [
            "bundle".to_string(),
            "check".to_string(),
            "--no-upgrade".to_string(),
            "--file".to_string(),
            brewfile.to_string_lossy().to_string(),
        ],
    )
    .with_env("HOMEBREW_NO_AUTO_UPDATE", "1")
}

fn brew_bundle_cleanup_preview_command(brewfile: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "brew",
        [
            "bundle".to_string(),
            "cleanup".to_string(),
            "--file".to_string(),
            brewfile.to_string_lossy().to_string(),
        ],
    )
}

fn brew_bundle_cleanup_force_command(brewfile: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "brew",
        [
            "bundle".to_string(),
            "cleanup".to_string(),
            "--force".to_string(),
            "--file".to_string(),
            brewfile.to_string_lossy().to_string(),
        ],
    )
}

fn mise_install_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "install".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

fn mise_verify_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "install".to_string(),
            "--dry-run-code".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

fn mise_prune_preview_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "prune".to_string(),
            "--dry-run-code".to_string(),
            "--tools".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

fn mise_prune_tools_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "prune".to_string(),
            "--tools".to_string(),
            "--yes".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

fn mise_reshim_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "reshim".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

fn npm_global_install_command(manifest_dir: &Path, packages: &[String]) -> ToolCommandSpec {
    let mut args = npm_exec_prefix(manifest_dir);
    args.extend([
        "npm".to_string(),
        "install".to_string(),
        "--global".to_string(),
    ]);
    args.extend(packages.iter().cloned());
    ToolCommandSpec::new("mise", args)
}

fn npm_global_verify_command(manifest_dir: &Path, packages: &[String]) -> ToolCommandSpec {
    let mut args = npm_exec_prefix(manifest_dir);
    args.extend([
        "npm".to_string(),
        "list".to_string(),
        "--global".to_string(),
        "--depth=0".to_string(),
    ]);
    args.extend(packages.iter().cloned());
    ToolCommandSpec::new("mise", args)
}

fn npm_global_list_command(manifest_dir: &Path) -> ToolCommandSpec {
    let mut args = npm_exec_prefix(manifest_dir);
    args.extend([
        "npm".to_string(),
        "list".to_string(),
        "--global".to_string(),
        "--depth=0".to_string(),
        "--json".to_string(),
    ]);
    ToolCommandSpec::new("mise", args)
}

fn npm_global_uninstall_command(manifest_dir: &Path, packages: &[String]) -> ToolCommandSpec {
    let mut args = npm_exec_prefix(manifest_dir);
    args.extend([
        "npm".to_string(),
        "uninstall".to_string(),
        "--global".to_string(),
    ]);
    args.extend(packages.iter().cloned());
    ToolCommandSpec::new("mise", args)
}

fn npm_exec_prefix(manifest_dir: &Path) -> Vec<String> {
    vec![
        "exec".to_string(),
        "-C".to_string(),
        manifest_dir.to_string_lossy().to_string(),
        "--".to_string(),
    ]
}

fn brew_upgrade_commands() -> [ToolCommandSpec; 2] {
    [
        ToolCommandSpec::new("brew", ["update"]),
        ToolCommandSpec::new("brew", ["upgrade"]),
    ]
}

fn run_tool_command(command: &ToolCommandSpec, current_dir: &Path) -> anyhow::Result<()> {
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

fn run_tool_command_status(
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

fn command_output_spec(command: &ToolCommandSpec, current_dir: &Path) -> anyhow::Result<String> {
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
mod tests {
    use super::*;

    #[test]
    fn test_find_manifest_root_from_current_repo() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let nested = root.join("src").join("cli");

        assert_eq!(find_manifest_root_from(&nested), Some(root));
    }

    #[test]
    fn test_find_manifest_root_from_unrelated_dir() {
        assert_eq!(find_manifest_root_from(Path::new("/")), None);
    }

    #[test]
    fn test_verify_commands_do_not_upgrade_or_install() {
        let brewfile = Path::new("/repo/manifests/Brewfile");
        let manifest_dir = Path::new("/repo/manifests");

        assert_eq!(
            brew_bundle_check_command(brewfile),
            ToolCommandSpec {
                program: "brew",
                args: vec![
                    "bundle".into(),
                    "check".into(),
                    "--no-upgrade".into(),
                    "--file".into(),
                    "/repo/manifests/Brewfile".into(),
                ],
                envs: vec![("HOMEBREW_NO_AUTO_UPDATE", "1")],
            }
        );
        assert_eq!(
            mise_verify_command(manifest_dir),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "install".into(),
                    "--dry-run-code".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                ],
                envs: vec![],
            }
        );
    }

    #[test]
    fn test_brew_upgrade_commands_only_update_and_upgrade() {
        let commands = brew_upgrade_commands();

        assert_eq!(
            commands,
            [
                ToolCommandSpec {
                    program: "brew",
                    args: vec!["update".into()],
                    envs: vec![],
                },
                ToolCommandSpec {
                    program: "brew",
                    args: vec!["upgrade".into()],
                    envs: vec![],
                },
            ]
        );
    }

    #[test]
    fn test_cleanup_commands_preview_before_force() {
        let brewfile = Path::new("/repo/manifests/Brewfile");
        let manifest_dir = Path::new("/repo/manifests");

        assert_eq!(
            brew_bundle_cleanup_preview_command(brewfile),
            ToolCommandSpec {
                program: "brew",
                args: vec![
                    "bundle".into(),
                    "cleanup".into(),
                    "--file".into(),
                    "/repo/manifests/Brewfile".into(),
                ],
                envs: vec![],
            }
        );
        assert_eq!(
            brew_bundle_cleanup_force_command(brewfile),
            ToolCommandSpec {
                program: "brew",
                args: vec![
                    "bundle".into(),
                    "cleanup".into(),
                    "--force".into(),
                    "--file".into(),
                    "/repo/manifests/Brewfile".into(),
                ],
                envs: vec![],
            }
        );
        assert_eq!(
            mise_prune_preview_command(manifest_dir),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "prune".into(),
                    "--dry-run-code".into(),
                    "--tools".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                ],
                envs: vec![],
            }
        );
        assert_eq!(
            mise_prune_tools_command(manifest_dir),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "prune".into(),
                    "--tools".into(),
                    "--yes".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                ],
                envs: vec![],
            }
        );
    }

    #[test]
    fn test_npm_global_commands_use_mise_node() {
        let manifest_dir = Path::new("/repo/manifests");
        let packages = vec!["agent-browser".to_string(), "pnpm".to_string()];

        assert_eq!(
            npm_global_install_command(manifest_dir, &packages),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "exec".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                    "--".into(),
                    "npm".into(),
                    "install".into(),
                    "--global".into(),
                    "agent-browser".into(),
                    "pnpm".into(),
                ],
                envs: vec![],
            }
        );
        assert_eq!(
            npm_global_verify_command(manifest_dir, &packages),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "exec".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                    "--".into(),
                    "npm".into(),
                    "list".into(),
                    "--global".into(),
                    "--depth=0".into(),
                    "agent-browser".into(),
                    "pnpm".into(),
                ],
                envs: vec![],
            }
        );
        assert_eq!(
            npm_global_uninstall_command(manifest_dir, &packages),
            ToolCommandSpec {
                program: "mise",
                args: vec![
                    "exec".into(),
                    "-C".into(),
                    "/repo/manifests".into(),
                    "--".into(),
                    "npm".into(),
                    "uninstall".into(),
                    "--global".into(),
                    "agent-browser".into(),
                    "pnpm".into(),
                ],
                envs: vec![],
            }
        );
    }

    #[test]
    fn test_removable_npm_globals_protects_runtime_packages() {
        let installed = vec![
            "agent-browser".to_string(),
            "npm".to_string(),
            "corepack".to_string(),
            "old-tool".to_string(),
        ];
        let desired = vec!["agent-browser".to_string()];

        assert_eq!(
            removable_npm_global_packages(&installed, &desired),
            vec!["old-tool".to_string()]
        );
    }
}
