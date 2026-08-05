use clap::Subcommand;

mod brew;
mod bun;
mod install;
mod shared;
pub mod verify;

#[derive(Subcommand)]
pub enum ToolCommands {
    /// リポジトリのマニフェストからツールをインストール
    Install,
    /// Homebrew / mise のツールマニフェストを検証
    Verify,
    /// Homebrew 操作
    #[command(subcommand)]
    Brew(ToolBrewCommands),
    /// bun global パッケージ操作
    #[command(subcommand)]
    Bun(ToolBunCommands),
}

#[derive(Subcommand)]
pub enum ToolBrewCommands {
    /// インストール済み Homebrew パッケージを更新
    Upgrade,
}

#[derive(Subcommand)]
pub enum ToolBunCommands {
    /// マニフェスト記載の bun global パッケージを更新
    Upgrade,
}

pub fn run(cmd: ToolCommands) -> anyhow::Result<()> {
    match cmd {
        ToolCommands::Install => install::install(),
        ToolCommands::Verify => verify::verify(),
        ToolCommands::Brew(sub) => match sub {
            ToolBrewCommands::Upgrade => brew::upgrade(),
        },
        ToolCommands::Bun(sub) => match sub {
            ToolBunCommands::Upgrade => bun::upgrade(),
        },
    }
}
