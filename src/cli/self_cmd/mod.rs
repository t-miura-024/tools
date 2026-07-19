use clap::Subcommand;
use clap_complete::Shell;

mod completions;
mod install;

#[derive(Subcommand)]
pub enum SelfCommands {
    /// mt バイナリのビルドとシェル環境整備
    Install,
    /// シェル補完スクリプトを生成
    Completions {
        /// 補完を生成するシェル
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
