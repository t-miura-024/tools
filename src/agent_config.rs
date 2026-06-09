use clap::Subcommand;

pub mod bootstrap;
pub mod claude;
pub mod frontmatter;
pub mod hook;
pub mod opencode;
pub mod sync;

#[derive(Subcommand)]
pub enum AgentConfigCommands {
    /// Sync agent-configs to all platforms (Cursor/Claude/OpenCode)
    Sync,
    /// Hook for blocking direct edits to protected directories
    Hook {
        #[arg(long)]
        check: bool,
    },
    /// Bootstrap: sync + install post-commit hook
    Bootstrap,
}

pub fn run(cmd: AgentConfigCommands) -> anyhow::Result<()> {
    match cmd {
        AgentConfigCommands::Sync => sync::run(),
        AgentConfigCommands::Hook { check } => {
            if check {
                hook::check()
            } else {
                anyhow::bail!("--check flag is required")
            }
        }
        AgentConfigCommands::Bootstrap => bootstrap::run(),
    }
}
