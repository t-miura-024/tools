use std::path::Path;

use crate::cli::style;
use crate::tool::shared::{
    Manifests, NpmGlobalPackage, ToolCommandSpec, ensure_command, ensure_mise_trusted,
    npm_exec_prefix, read_npm_global_packages, run_tool_command,
};

pub(super) fn verify() -> anyhow::Result<()> {
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

fn npm_global_verify_command(
    manifest_dir: &Path,
    packages: &[NpmGlobalPackage],
) -> ToolCommandSpec {
    let mut args = npm_exec_prefix(manifest_dir);
    args.extend([
        "npm".to_string(),
        "list".to_string(),
        "--global".to_string(),
        "--depth=0".to_string(),
    ]);
    args.extend(packages.iter().map(|package| package.name.clone()));
    ToolCommandSpec::new("mise", args)
}

#[cfg(test)]
#[path = "verify.test.rs"]
mod tests;
