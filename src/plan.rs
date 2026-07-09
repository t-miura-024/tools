use clap::Subcommand;

pub mod draft;

#[derive(Subcommand)]
pub enum PlanCommands {
    /// 新しい計画 Issue を draft で作成する
    Draft {
        /// 確認プロンプトをスキップ
        #[arg(long)]
        yes: bool,
    },
}

pub fn run(cmd: PlanCommands) -> anyhow::Result<()> {
    match cmd {
        PlanCommands::Draft { yes } => draft::run(yes),
    }
}
