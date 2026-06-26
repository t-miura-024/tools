use clap::Subcommand;

mod install;

#[derive(Subcommand)]
pub enum SelfCommands {
    /// Install mt binary via cargo install --path . and run chezmoi apply
    Install,
}

pub fn run(cmd: SelfCommands) -> anyhow::Result<()> {
    match cmd {
        SelfCommands::Install => install::run(),
    }
}
