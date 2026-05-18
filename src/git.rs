use clap::Subcommand;

pub mod repo;

#[derive(Subcommand)]
pub enum GitCommands {
    /// GitHub repository operations
    #[command(subcommand)]
    Repo(GitRepoCommands),
}

#[derive(Subcommand)]
pub enum GitRepoCommands {
    /// Create a new GitHub repository interactively
    Create,
}

pub fn run(cmd: GitCommands) -> anyhow::Result<()> {
    match cmd {
        GitCommands::Repo(sub) => match sub {
            GitRepoCommands::Create => repo::create(),
        },
    }
}
