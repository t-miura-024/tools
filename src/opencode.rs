use clap::Subcommand;

pub mod oauth;
pub mod web;

#[derive(Subcommand)]
pub enum OpencodeCommands {
    /// Google OAuth セットアップ
    #[command(subcommand)]
    Oauth(OpencodeOauthCommands),
    /// OpenCode Web の ngrok 公開 / 停止
    #[command(subcommand)]
    Web(OpencodeWebCommands),
}

#[derive(Subcommand)]
pub enum OpencodeOauthCommands {
    /// Google OAuth を対話的にセットアップ
    Setup,
}

#[derive(Subcommand)]
pub enum OpencodeWebCommands {
    /// ngrok で OpenCode Web を公開
    Expose,
    /// ngrok セッションを停止
    Stop,
}

pub fn run(cmd: OpencodeCommands) -> anyhow::Result<()> {
    match cmd {
        OpencodeCommands::Oauth(sub) => match sub {
            OpencodeOauthCommands::Setup => oauth::setup(),
        },
        OpencodeCommands::Web(sub) => match sub {
            OpencodeWebCommands::Expose => web::expose(),
            OpencodeWebCommands::Stop => web::stop(),
        },
    }
}
