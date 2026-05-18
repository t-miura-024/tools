use clap::Subcommand;

pub mod oauth;
pub mod web;

#[derive(Subcommand)]
pub enum OpencodeCommands {
    /// Google OAuth setup
    #[command(subcommand)]
    Oauth(OpencodeOauthCommands),
    /// OpenCode Web ngrok expose/stop
    #[command(subcommand)]
    Web(OpencodeWebCommands),
}

#[derive(Subcommand)]
pub enum OpencodeOauthCommands {
    /// Set up Google OAuth interactively
    Setup,
}

#[derive(Subcommand)]
pub enum OpencodeWebCommands {
    /// Expose OpenCode Web via ngrok
    Expose,
    /// Stop the ngrok session
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
