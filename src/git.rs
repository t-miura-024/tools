use clap::Subcommand;

pub mod common;
pub mod repo;
pub mod ship;
pub mod sync;
pub mod worktree;

#[derive(Subcommand)]
pub enum GitCommands {
    /// Sync current branch with upstream and pull target branch into it
    Sync {
        /// Target branch to pull into the current branch (mutually exclusive with --target-default)
        #[arg(long, conflicts_with = "target_default")]
        target: Option<String>,
        /// Use the detected default branch as target (skips --target and fzf prompt)
        #[arg(long)]
        target_default: bool,
    },
    /// Stage, commit, push, and merge the current branch into the target branch
    Ship {
        /// Target branch to merge into (mutually exclusive with --target-default)
        #[arg(long, conflicts_with = "target_default")]
        target: Option<String>,
        /// Use the detected default branch as target (skips --target and fzf prompt)
        #[arg(long)]
        target_default: bool,
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
    /// Select a parent Git repository under ~/doc or ~/src and print its path (worktrees are excluded; use `git worktree select` for those)
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
        GitCommands::Sync {
            target,
            target_default,
        } => sync::sync(target, target_default),
        GitCommands::Ship {
            target,
            target_default,
            message,
        } => ship::ship(target, target_default, message),
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
