use clap::Subcommand;

pub mod add;
pub mod apply;
pub mod diff;
pub mod doctor;
pub mod edit;
pub mod init;
pub mod install_hook;
pub mod secret;
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
    /// Manage secrets in dot_zsh_secrets.age
    #[command(subcommand)]
    Secret(SecretCommands),
    /// Remove the mt post-commit hook (Phase 2 で本実装)
    UninstallHook,
}

#[derive(Subcommand)]
pub enum SecretCommands {
    /// Set or update a secret value (encrypts into dot_zsh_secrets.age)
    #[command(name = "set")]
    Set {
        /// Environment variable name to set (e.g. TAVILY_API_KEY)
        key: String,
        /// Preview the encrypted content without writing
        #[arg(long)]
        dry_run: bool,
        /// Skip the apply prompt after setting
        #[arg(long)]
        no_apply: bool,
    },
    /// Delete a secret value from dot_zsh_secrets.age
    #[command(name = "delete")]
    Delete {
        /// Environment variable name to delete (e.g. TAVILY_API_KEY)
        key: String,
        /// Preview the encrypted content without writing
        #[arg(long)]
        dry_run: bool,
        /// Skip the apply prompt after deleting
        #[arg(long)]
        no_apply: bool,
    },
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
        ChezmoiCommands::Secret(SecretCommands::Set {
            key,
            dry_run,
            no_apply,
        }) => secret::run_set(secret::SecretSetArgs {
            key: &key,
            dry_run,
            skip_apply: no_apply,
        }),
        ChezmoiCommands::Secret(SecretCommands::Delete {
            key,
            dry_run,
            no_apply,
        }) => secret::run_delete(secret::SecretDeleteArgs {
            key: &key,
            dry_run,
            skip_apply: no_apply,
        }),
    }
}
