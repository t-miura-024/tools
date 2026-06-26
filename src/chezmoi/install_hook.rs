use crate::cli::style;

/// Phase 1 scaffold for the `mt chezmoi install-hook` subcommand.
///
/// Phase 2 will implement the full post-commit hook that syncs
/// `chezmoi/` source changes to the home directory. For now this
/// command prints a notice and exits 0.
pub fn run() -> anyhow::Result<()> {
    style::intro("mt chezmoi install-hook");
    style::warn(
        "Phase 1 では install-hook は足場のみ提供。Phase 2 で本実装します。",
    );
    style::info("Phase 2 では `chezmoi/` ソース変更時に `chezmoi apply` を自動実行する post-commit hook を設置します。");
    style::outro("install-hook: Phase 1 では何もしません");
    Ok(())
}
