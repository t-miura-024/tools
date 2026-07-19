use clap::Subcommand;

mod install;

#[derive(Subcommand)]
pub enum SelfCommands {
    /// mt バイナリのビルドとシェル環境整備
    Install,
}

pub fn run(cmd: SelfCommands) -> anyhow::Result<()> {
    match cmd {
        SelfCommands::Install => install::run(),
    }
}
