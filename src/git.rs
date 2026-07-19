use clap::Subcommand;

pub mod common;
pub mod repo;
pub mod ship;
pub mod sync;
pub mod worktree;

#[derive(Subcommand)]
pub enum GitCommands {
    /// 現在のブランチを upstream と同期し、ターゲットブランチを pull で取り込む
    Sync {
        /// 現在のブランチに取り込むターゲットブランチ（--target-default と排他）
        #[arg(long, conflicts_with = "target_default")]
        target: Option<String>,
        /// 検出されたデフォルトブランチをターゲットとして使用（--target と fzf をスキップ）
        #[arg(long)]
        target_default: bool,
    },
    /// ステージ・コミット・プッシュし、現在のブランチをターゲットブランチにマージ
    Ship {
        /// マージ先のターゲットブランチ（--target-default と排他）
        #[arg(long, conflicts_with = "target_default")]
        target: Option<String>,
        /// 検出されたデフォルトブランチをターゲットとして使用（--target と fzf をスキップ）
        #[arg(long)]
        target_default: bool,
        /// コミットメッセージ（省略時はステージ済み差分から自動生成）
        #[arg(long)]
        message: Option<String>,
    },
    /// GitHub リポジトリ操作
    #[command(subcommand)]
    Repo(GitRepoCommands),
    /// Git worktree 操作
    #[command(subcommand)]
    Worktree(GitWorktreeCommands),
}

#[derive(Subcommand)]
pub enum GitRepoCommands {
    /// GitHub リポジトリを対話的に作成
    Create,
    /// ~/doc か ~/src 配下の親 Git リポジトリを選択してパスを出力（worktree は対象外）
    Select,
}

#[derive(Subcommand)]
pub enum GitWorktreeCommands {
    /// Git worktree を選択してパスを出力
    Select,
    /// Git worktree と新規ブランチを対話的に作成
    Create {
        /// 作成後に origin へのプッシュをスキップ
        #[arg(long)]
        no_push: bool,
    },
    /// Git worktree を対話的に削除（安全チェック付き）
    Delete {
        /// 全安全チェックをスキップし強制削除
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
            GitWorktreeCommands::Create { no_push } => worktree::create(no_push),
            GitWorktreeCommands::Delete { force } => worktree::delete(force),
        },
    }
}
