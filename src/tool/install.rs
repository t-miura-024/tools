use std::collections::BTreeSet;
use std::path::Path;

use dialoguer::Confirm;

use crate::cli::style;
use crate::tool::shared::{
    BunGlobalPackage, Manifests, ToolCommandSpec, command_output_spec, ensure_command,
    ensure_mise_trusted, mise_exec_prefix, parse_bun_pm_ls_output, read_bun_global_packages,
    run_tool_command, run_tool_command_status,
};

pub(super) fn install() -> anyhow::Result<()> {
    style::intro("ツールインストール");

    let manifests = Manifests::discover()?;
    manifests.ensure_files()?;
    ensure_command("brew")?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;
    let bun_packages = read_bun_global_packages(&manifests.bun_global)?;

    run_tool_command(
        &brew_bundle_install_command(&manifests.brewfile),
        &manifests.root,
    )?;
    run_tool_command(
        &mise_install_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    if !bun_packages.is_empty() {
        run_tool_command(
            &bun_global_install_command(&manifests.manifest_dir, &bun_packages),
            &manifests.root,
        )?;
        run_tool_command(
            &mise_reshim_command(&manifests.manifest_dir),
            &manifests.root,
        )?;
    }
    cleanup_after_install(&manifests, &bun_packages)?;

    style::outro("✅ ツールのインストールが完了しました");
    Ok(())
}

fn cleanup_after_install(
    manifests: &Manifests,
    bun_packages: &[BunGlobalPackage],
) -> anyhow::Result<()> {
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
    cleanup_bun_globals(manifests, bun_packages)?;

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

fn cleanup_bun_globals(
    manifests: &Manifests,
    desired_packages: &[BunGlobalPackage],
) -> anyhow::Result<()> {
    style::info("bun global の削除候補を確認します");
    let installed_packages =
        installed_bun_global_packages(&manifests.manifest_dir, &manifests.root)?;
    let desired_names: Vec<String> = desired_packages
        .iter()
        .map(|package| package.name.clone())
        .collect();
    let removable = removable_bun_global_packages(&installed_packages, &desired_names);

    if removable.is_empty() {
        style::success("bun global の削除候補はありません");
        return Ok(());
    }

    for package in &removable {
        style::info(&format!("削除候補: bun global {}", package));
    }

    let cleanup = Confirm::new()
        .with_prompt("bun global の削除候補があります。削除しますか？")
        .default(false)
        .interact()?;

    if cleanup {
        run_tool_command(
            &bun_global_uninstall_command(&manifests.manifest_dir, &removable),
            &manifests.root,
        )?;
        run_tool_command(
            &mise_reshim_command(&manifests.manifest_dir),
            &manifests.root,
        )?;
    } else {
        style::info("bun global の削除はスキップしました");
    }

    Ok(())
}

fn installed_bun_global_packages(
    manifest_dir: &Path,
    current_dir: &Path,
) -> anyhow::Result<Vec<String>> {
    let output = command_output_spec(&bun_global_list_command(manifest_dir), current_dir)?;
    let packages = parse_bun_pm_ls_output(&output);
    Ok(packages)
}

fn removable_bun_global_packages(installed: &[String], desired: &[String]) -> Vec<String> {
    let desired: BTreeSet<&str> = desired.iter().map(String::as_str).collect();

    installed
        .iter()
        .filter(|package| !desired.contains(package.as_str()))
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

fn bun_global_install_command(
    manifest_dir: &Path,
    packages: &[BunGlobalPackage],
) -> ToolCommandSpec {
    let mut args = mise_exec_prefix(manifest_dir);
    args.extend(["bun".to_string(), "install".to_string(), "-g".to_string()]);
    args.extend(
        packages
            .iter()
            .map(|package| format!("{}@{}", package.name, package.version)),
    );
    ToolCommandSpec::new("mise", args)
}

fn bun_global_list_command(manifest_dir: &Path) -> ToolCommandSpec {
    let mut args = mise_exec_prefix(manifest_dir);
    args.extend([
        "bun".to_string(),
        "pm".to_string(),
        "ls".to_string(),
        "-g".to_string(),
        "--all".to_string(),
    ]);
    ToolCommandSpec::new("mise", args)
}

fn bun_global_uninstall_command(manifest_dir: &Path, packages: &[String]) -> ToolCommandSpec {
    let mut args = mise_exec_prefix(manifest_dir);
    args.extend(["bun".to_string(), "remove".to_string(), "-g".to_string()]);
    args.extend(packages.iter().cloned());
    ToolCommandSpec::new("mise", args)
}

#[cfg(test)]
#[path = "install.test.rs"]
mod tests;
