use clap::{Parser, Subcommand};

mod cli;
mod config;
mod git;
mod opencode;

#[derive(Parser)]
#[command(name = "mt", about = "Personal CLI tools")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Check ~/.cargo/bin PATH and set up mt command
    Init,
    /// git: GitHub repository operations
    #[command(subcommand)]
    Git(git::GitCommands),
    /// opencode: OpenCode Web operations
    #[command(subcommand)]
    Opencode(opencode::OpencodeCommands),
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => cli::launcher::run(),
        Some(Commands::Init) => cli::init::run(),
        Some(Commands::Git(cmd)) => git::run(cmd),
        Some(Commands::Opencode(cmd)) => opencode::run(cmd),
    }
}
