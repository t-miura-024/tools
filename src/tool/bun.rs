use std::path::Path;

use crate::cli::style;
use crate::tool::shared::{
    Manifests, ToolCommandSpec, ensure_command, ensure_mise_trusted, mise_exec_prefix,
    read_bun_global_packages, run_tool_command,
};

pub(super) fn upgrade() -> anyhow::Result<()> {
    style::intro("bun global パッケージ更新");

    let manifests = Manifests::discover()?;
    manifests.ensure_bun_files()?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;
    let packages = read_bun_global_packages(&manifests.bun_global)?;

    for package in &packages {
        run_tool_command(
            &bun_upgrade_command(&manifests.manifest_dir, &package.name),
            &manifests.root,
        )?;
    }
    run_tool_command(
        &mise_reshim_command(&manifests.manifest_dir),
        &manifests.root,
    )?;

    style::outro("✅ bun global パッケージの更新が完了しました");
    Ok(())
}

fn bun_upgrade_command(manifest_dir: &Path, name: &str) -> ToolCommandSpec {
    let mut args = mise_exec_prefix(manifest_dir);
    args.extend([
        "bun".to_string(),
        "update".to_string(),
        "-g".to_string(),
        name.to_string(),
    ]);
    ToolCommandSpec::new("mise", args)
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

#[cfg(test)]
#[path = "bun.test.rs"]
mod tests;
