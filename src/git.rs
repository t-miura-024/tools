use clap::Subcommand;

pub mod repo;
pub mod worktree;

#[derive(Subcommand)]
pub enum GitCommands {
    /// GitHub repository operations
    #[command(subcommand)]
    Repo(GitRepoCommands),
    /// Git worktree operations
    #[command(subcommand)]
    Worktree(GitWorktreeCommands),
}

#[derive(Subcommand)]
pub enum GitRepoCommands {
    /// Create a new GitHub repository interactively
    Create,
}

#[derive(Subcommand)]
pub enum GitWorktreeCommands {
    /// Select a Git worktree and print its path
    Select,
}

pub fn run(cmd: GitCommands) -> anyhow::Result<()> {
    match cmd {
        GitCommands::Repo(sub) => match sub {
            GitRepoCommands::Create => repo::create(),
        },
        GitCommands::Worktree(sub) => match sub {
            GitWorktreeCommands::Select => worktree::select(),
        },
    }
}
