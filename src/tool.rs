use clap::Subcommand;

mod brew;
mod install;
mod shared;
mod verify;

#[derive(Subcommand)]
pub enum ToolCommands {
    /// Install tools from repository manifests
    Install,
    /// Verify Homebrew and mise tool manifests
    Verify,
    /// Homebrew operations
    #[command(subcommand)]
    Brew(ToolBrewCommands),
}

#[derive(Subcommand)]
pub enum ToolBrewCommands {
    /// Upgrade installed Homebrew packages
    Upgrade,
}

pub fn run(cmd: ToolCommands) -> anyhow::Result<()> {
    match cmd {
        ToolCommands::Install => install::install(),
        ToolCommands::Verify => verify::verify(),
        ToolCommands::Brew(sub) => match sub {
            ToolBrewCommands::Upgrade => brew::upgrade(),
        },
    }
}
