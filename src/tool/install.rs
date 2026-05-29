use std::collections::BTreeSet;
use std::path::Path;

use dialoguer::Confirm;

use crate::cli::style;
use crate::tool::shared::{
    Manifests, ToolCommandSpec, command_output_spec, ensure_command, ensure_mise_trusted,
    npm_exec_prefix, read_npm_global_packages, run_tool_command, run_tool_command_status,
};

pub(super) fn install() -> anyhow::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_npm_global_install_and_uninstall_use_mise_node() {
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
