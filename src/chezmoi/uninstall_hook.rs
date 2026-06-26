use crate::cli::style;

/// Phase 1 scaffold for the `mt chezmoi uninstall-hook` subcommand.
///
/// Phase 2 will implement removal of the chezmoi post-commit hook
/// installed by `mt chezmoi install-hook`. For now this command
/// prints a notice and exits 0.
pub fn run() -> anyhow::Result<()> {
    style::intro("mt chezmoi uninstall-hook");
    style::warn(
        "Phase 1 では uninstall-hook は足場のみ提供。Phase 2 で本実装します。",
    );
    style::outro("uninstall-hook: Phase 1 では何もしません");
    Ok(())
}
