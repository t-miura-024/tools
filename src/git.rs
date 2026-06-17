use clap::Subcommand;

pub mod begin;
pub mod common;
pub mod repo;
pub mod ship;
pub mod worktree;

#[derive(Subcommand)]
pub enum GitCommands {
    /// Sync current branch with upstream and pull target branch into it
    Begin {
        /// Target branch to pull into the current branch (default: detected default branch)
        #[arg(long)]
        target: Option<String>,
    },
    /// Stage, commit, push, and merge the current branch into the target branch
    Ship {
        /// Target branch to merge into (default: detected default branch)
        #[arg(long)]
        target: Option<String>,
        /// Commit message (default: auto-generated from staged diff)
        #[arg(long)]
        message: Option<String>,
    },
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
    /// Select a Git repository under ~/doc or ~/src and print its path
    Select,
}

#[derive(Subcommand)]
pub enum GitWorktreeCommands {
    /// Select a Git worktree and print its path
    Select,
    /// Create a new Git worktree and branch interactively
    Create,
    /// Delete a Git worktree interactively (with safety checks)
    Delete {
        /// Skip all safety checks and force removal
        #[arg(long)]
        force: bool,
    },
}

pub fn run(cmd: GitCommands) -> anyhow::Result<()> {
    match cmd {
        GitCommands::Begin { target } => begin::begin(target),
        GitCommands::Ship { target, message } => ship::ship(target, message),
        GitCommands::Repo(sub) => match sub {
            GitRepoCommands::Create => repo::create(),
            GitRepoCommands::Select => repo::select(),
        },
        GitCommands::Worktree(sub) => match sub {
            GitWorktreeCommands::Select => worktree::select(),
            GitWorktreeCommands::Create => worktree::create(),
            GitWorktreeCommands::Delete { force } => worktree::delete(force),
        },
    }
}
