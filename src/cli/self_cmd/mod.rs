use clap::Subcommand;
use clap_complete::Shell;

mod completions;
mod install;

#[derive(Subcommand)]
pub enum SelfCommands {
    /// Install mt binary via cargo install --path . and run chezmoi apply
    Install,
    /// Generate shell completion script
    Completions {
        /// Shell to generate completions for
        #[arg(value_enum)]
        shell: Shell,
    },
}

pub fn run(cmd: SelfCommands) -> anyhow::Result<()> {
    match cmd {
        SelfCommands::Install => install::run(),
        SelfCommands::Completions { shell } => completions::run(shell),
    }
}
