use std::path::Path;

use crate::cli::style;
use crate::tool::shared::{
    BunGlobalPackage, Manifests, ToolCommandSpec, command_output_spec, ensure_command,
    ensure_mise_trusted, mise_exec_prefix, parse_bun_pm_ls_output, read_bun_global_packages,
    run_tool_command,
};

pub(super) fn verify() -> anyhow::Result<()> {
    style::intro("ツール管理の検証");

    let manifests = Manifests::discover()?;
    manifests.ensure_files()?;
    ensure_command("brew")?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;
    let bun_packages = read_bun_global_packages(&manifests.bun_global)?;

    run_tool_command(
        &brew_bundle_check_command(&manifests.brewfile),
        &manifests.root,
    )?;
    run_tool_command(
        &mise_verify_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    if !bun_packages.is_empty() {
        verify_bun_global_packages(&manifests.manifest_dir, &manifests.root, &bun_packages)?;
    }

    style::outro("✅ ツール管理の検証が完了しました");
    Ok(())
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

fn verify_bun_global_packages(
    manifest_dir: &Path,
    current_dir: &Path,
    packages: &[BunGlobalPackage],
) -> anyhow::Result<()> {
    let output = command_output_spec(&bun_global_list_command(manifest_dir), current_dir)?;
    let installed: std::collections::BTreeSet<String> =
        parse_bun_pm_ls_output(&output).into_iter().collect();
    let missing: Vec<&str> = packages
        .iter()
        .map(|p| p.name.as_str())
        .filter(|name| !installed.contains(*name))
        .collect();

    if missing.is_empty() {
        style::success("すべての bun global パッケージがインストールされています");
        Ok(())
    } else {
        anyhow::bail!(
            "bun global に未インストールのパッケージがあります: {}",
            missing.join(", ")
        )
    }
}

fn bun_global_list_command(manifest_dir: &Path) -> ToolCommandSpec {
    let mut args = mise_exec_prefix(manifest_dir);
    args.extend([
        "bun".to_string(),
        "pm".to_string(),
        "ls".to_string(),
        "-g".to_string(),
    ]);
    ToolCommandSpec::new("mise", args)
}

#[cfg(test)]
#[path = "verify.test.rs"]
mod tests;
