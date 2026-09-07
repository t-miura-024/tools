use clap::Subcommand;

pub mod client;
pub mod plugin;
pub mod socket;
pub mod tab;
pub mod template;
pub mod workspace;

#[derive(Subcommand)]
pub enum HerdrCommands {
    /// herdr ワークスペース操作
    #[command(subcommand)]
    Workspace(workspace::HerdrWorkspaceCommands),
    /// herdr タブ操作
    #[command(subcommand)]
    Tab(tab::HerdrTabCommands),
    /// herdr プラグインの manifest 管理同期
    #[command(subcommand)]
    Plugin(plugin::HerdrPluginCommands),
}

pub fn run(cmd: HerdrCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrCommands::Workspace(sub) => workspace::run(sub),
        HerdrCommands::Tab(sub) => tab::run(sub),
        HerdrCommands::Plugin(sub) => plugin::run(sub),
    }
}
