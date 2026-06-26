use clap::Subcommand;

pub mod add;
pub mod apply;
pub mod diff;
pub mod doctor;
pub mod edit;
pub mod init;
pub mod install_hook;
pub mod shared;
pub mod status;
pub mod uninstall_hook;

#[derive(Subcommand)]
pub enum ChezmoiCommands {
    /// Apply the chezmoi source state to the home directory
    Apply,
    /// Initialize the chezmoi source state (clone, pull, etc.)
    Init,
    /// Show the diff between the target state and the destination state
    Diff,
    /// Show the status of chezmoi-managed targets
    Status,
    /// Run chezmoi doctor plus mt-specific checks (env var, source dir, age key, post-commit hook)
    Doctor,
    /// Add an existing file or directory to the chezmoi source state
    Add,
    /// Edit the chezmoi source state of a target
    Edit,
    /// Install the mt post-commit hook (Phase 2 で本実装)
    InstallHook,
    /// Remove the mt post-commit hook (Phase 2 で本実装)
    UninstallHook,
}

pub fn run(cmd: ChezmoiCommands) -> anyhow::Result<()> {
    match cmd {
        ChezmoiCommands::Apply => apply::run(&[]),
        ChezmoiCommands::Init => init::run(&[]),
        ChezmoiCommands::Diff => diff::run(&[]),
        ChezmoiCommands::Status => status::run(&[]),
        ChezmoiCommands::Doctor => doctor::run(),
        ChezmoiCommands::Add => add::run(&[]),
        ChezmoiCommands::Edit => edit::run(&[]),
        ChezmoiCommands::InstallHook => install_hook::run(),
        ChezmoiCommands::UninstallHook => uninstall_hook::run(),
    }
}
