use clap::{Parser, Subcommand};

mod agent;
mod chezmoi;
mod cli;
mod config;
mod git;
mod opencode;
mod plan;
mod raycast;
mod tool;
mod vector;

#[derive(Parser)]
#[command(name = "mt", about = "個人用 CLI ツール群")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// mt バイナリ自身の操作（インストール・環境整備）
    #[command(name = "self", subcommand)]
    SelfCmd(cli::self_cmd::SelfCommands),
    /// Git / GitHub リポジトリ操作
    #[command(subcommand)]
    Git(git::GitCommands),
    /// OpenCode Web 操作
    #[command(subcommand)]
    Opencode(opencode::OpencodeCommands),
    /// Homebrew / mise によるツール管理
    #[command(subcommand)]
    Tool(tool::ToolCommands),
    /// dotfile 管理（chezmoi ラッパー + mt 固有サブコマンド）
    #[command(subcommand)]
    Chezmoi(chezmoi::ChezmoiCommands),
    /// Markdown のローカルベクトル検索
    #[command(subcommand)]
    Vector(vector::VectorCommands),
    /// mt-plan Issue 管理
    #[command(subcommand)]
    Plan(plan::PlanCommands),
    /// Raycast 設定のバックアップと復元
    #[command(subcommand)]
    Raycast(raycast::RaycastCommands),
    /// agents / skills のマルチプラットフォーム同期
    #[command(subcommand)]
    Agent(agent::AgentCommands),
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
        Some(Commands::Plan(cmd)) => plan::run(cmd),
        Some(Commands::Raycast(cmd)) => raycast::run(cmd),
        Some(Commands::Agent(cmd)) => agent::run(cmd),
    }
}
