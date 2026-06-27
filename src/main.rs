use clap::{Parser, Subcommand};

mod chezmoi;
mod cli;
mod config;
mod git;
mod opencode;
mod tool;
mod vector;

#[derive(Parser)]
#[command(name = "mt", about = "Personal CLI tools")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// self: operations on the mt binary itself
    #[command(name = "self", subcommand)]
    SelfCmd(cli::self_cmd::SelfCommands),
    /// git: GitHub repository operations
    #[command(subcommand)]
    Git(git::GitCommands),
    /// opencode: OpenCode Web operations
    #[command(subcommand)]
    Opencode(opencode::OpencodeCommands),
    /// tool: Homebrew and mise tool management
    #[command(subcommand)]
    Tool(tool::ToolCommands),
    /// chezmoi: dotfile management (chezmoi thin wrapper + mt 固有サブコマンド)
    #[command(subcommand)]
    Chezmoi(chezmoi::ChezmoiCommands),
    /// vector: local vector search over markdown
    #[command(subcommand)]
    Vector(vector::VectorCommands),
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => cli::launcher::run(),
        Some(Commands::SelfCmd(cmd)) => cli::self_cmd::run(cmd),
        Some(Commands::Git(cmd)) => git::run(cmd),
        Some(Commands::Opencode(cmd)) => opencode::run(cmd),
        Some(Commands::Tool(cmd)) => tool::run(cmd),
        Some(Commands::Chezmoi(cmd)) => chezmoi::run(cmd),
        Some(Commands::Vector(cmd)) => vector::run(cmd),
    }
}
