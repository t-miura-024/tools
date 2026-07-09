use clap::Subcommand;

pub mod restore;
pub mod shared;
pub mod sync;

#[derive(Subcommand)]
pub enum RaycastCommands {
    /// Raycast 設定をエクスポートして chezmoi 管理下に保存
    Sync,
    /// バックアップから Raycast 設定を復元
    Restore,
}

pub fn run(cmd: RaycastCommands) -> anyhow::Result<()> {
    match cmd {
        RaycastCommands::Sync => sync::run(),
        RaycastCommands::Restore => restore::run(),
    }
}
