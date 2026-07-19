use clap::Subcommand;

pub mod shared;
pub mod sync;

#[derive(Subcommand)]
pub enum AgentCommands {
    /// agents / skills を cursor (SoT) から Claude / OpenCode へ同期
    Sync {
        /// 同期せず差分の有無だけ確認（drift ありで非0終了）
        #[arg(short = 'c', long, conflicts_with = "dry_run")]
        check: bool,
        /// 書き込みせず同期内容を表示
        #[arg(short = 'n', long, conflicts_with = "check")]
        dry_run: bool,
    },
}

pub fn run(cmd: AgentCommands) -> anyhow::Result<()> {
    match cmd {
        AgentCommands::Sync { check, dry_run } => {
            let mode = if check {
                sync::SyncMode::Check
            } else if dry_run {
                sync::SyncMode::DryRun
            } else {
                sync::SyncMode::Sync
            };
            sync::run(mode)
        }
    }
}
