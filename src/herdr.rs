use clap::Subcommand;

pub mod client;
pub mod socket;
pub mod template;
pub mod workspace;

#[derive(Subcommand)]
pub enum HerdrCommands {
    /// herdr ワークスペース操作
    #[command(subcommand)]
    Workspace(workspace::HerdrWorkspaceCommands),
}

pub fn run(cmd: HerdrCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrCommands::Workspace(sub) => workspace::run(sub),
    }
}
