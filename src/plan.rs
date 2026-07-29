use std::path::PathBuf;

use clap::Subcommand;

pub mod draft;
pub mod draft_tui;

#[derive(Subcommand)]
pub enum PlanCommands {
    /// 新しい計画 Issue を draft で作成する
    Draft {
        /// Issue タイトル（非対話モード）。--body-file, --repo と同時に指定が必要
        #[arg(long)]
        title: Option<String>,
        /// Issue 本文を含むファイルのパス（非対話モード）。--title, --repo と同時に指定が必要
        #[arg(long)]
        body_file: Option<PathBuf>,
        /// 対象リポジトリのローカルパス（非対話モード）。--title, --body-file と同時に指定が必要
        #[arg(long)]
        repo: Option<PathBuf>,
    },
}

pub fn run(cmd: PlanCommands) -> anyhow::Result<()> {
    match cmd {
        PlanCommands::Draft {
            title,
            body_file,
            repo,
        } => draft::run(title, body_file, repo),
    }
}
