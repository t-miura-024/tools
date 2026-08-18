use std::path::Path;

use crate::cli::style;
use crate::tool::shared::{
    Manifests, ToolCommandSpec, ensure_command, ensure_mise_trusted, run_tool_command,
};

pub(super) fn upgrade() -> anyhow::Result<()> {
    style::intro("mise ツール更新");

    let manifests = Manifests::discover()?;
    manifests.ensure_mise_toml()?;
    ensure_command("mise")?;
    ensure_mise_trusted(&manifests.manifest_dir, &manifests.mise_toml)?;

    run_tool_command(
        &mise_upgrade_command(&manifests.manifest_dir),
        &manifests.root,
    )?;

    style::outro("✅ mise ツールの更新が完了しました");
    Ok(())
}

fn mise_upgrade_command(manifest_dir: &Path) -> ToolCommandSpec {
    ToolCommandSpec::new(
        "mise",
        [
            "upgrade".to_string(),
            "-C".to_string(),
            manifest_dir.to_string_lossy().to_string(),
        ],
    )
}

#[cfg(test)]
#[path = "mise.test.rs"]
mod tests;
