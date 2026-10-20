use std::path::Path;

use crate::cli::style;
use crate::tool::cask::broken_brewfile_casks;
use crate::tool::shared::{
    BunGlobalPackage, Manifests, ToolCommandSpec, command_output_spec, ensure_command,
    ensure_mise_trusted, mise_exec_prefix, parse_bun_pm_ls_output, read_bun_global_packages,
    run_tool_command,
};

/// ツールマニフェスト（Brewfile / mise.toml / bun-global.yml / herdr-plugins.toml）と
/// インストール状態の
/// 突合（drift 検証）を実行する。`mt doctor` がセクションとして再利用するため `pub`。
pub fn verify() -> anyhow::Result<()> {
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
    verify_cask_artifacts(&manifests)?;
    run_tool_command(
        &mise_verify_command(&manifests.manifest_dir),
        &manifests.root,
    )?;
    if !bun_packages.is_empty() {
        verify_bun_global_packages(&manifests.manifest_dir, &manifests.root, &bun_packages)?;
    }
    crate::herdr::plugin::verify_plugins(&manifests)?;

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

/// Brewfile の cask の実体が揃っているかを検証する。
///
/// `brew bundle check` は Caskroom のメタデータしか見ないため、アプリ本体が
/// Homebrew を経由せずに削除された drift をここで検出する。
fn verify_cask_artifacts(manifests: &Manifests) -> anyhow::Result<()> {
    let broken = broken_brewfile_casks(&manifests.brewfile)?;

    if broken.is_empty() {
        style::success("Brewfile の cask はすべて実体が揃っています");
        return Ok(());
    }

    let details: Vec<String> = broken
        .iter()
        .map(|cask| format!("{} ({})", cask.spec, cask.dangling_display()))
        .collect();
    anyhow::bail!(
        "実体が欠けている cask があります: {}。`mt tool install` で再インストールしてください",
        details.join(", ")
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
