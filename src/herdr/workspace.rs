use clap::Subcommand;

pub mod duplicate;

#[derive(Subcommand)]
pub enum HerdrWorkspaceCommands {
    /// 現在フォーカス中のワークスペースのタブ・ペーン構成を複製して新しいワークスペースを作成
    Duplicate {
        /// 複製先のリポジトリディレクトリ（省略時は ~/src, ~/doc 配下を fzf で選択）
        target: Option<String>,
    },
}

pub fn run(cmd: HerdrWorkspaceCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrWorkspaceCommands::Duplicate { target } => duplicate::duplicate(target),
    }
}