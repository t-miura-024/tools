use clap::Subcommand;

pub mod draft;
pub mod draft_tui;

#[derive(Subcommand)]
pub enum PlanCommands {
    /// 新しい計画 Issue を draft で作成する
    Draft,
}

pub fn run(cmd: PlanCommands) -> anyhow::Result<()> {
    match cmd {
        PlanCommands::Draft => draft::run(),
    }
}
