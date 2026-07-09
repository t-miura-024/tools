use crate::agent::shared;
use crate::cli::style;

use super::shared as chezmoi_shared;

pub fn run(_args: &[&str]) -> anyhow::Result<()> {
    if let Ok(Some(issues)) = shared::check_sync_status(&shared::chezmoi_source_dir()?) {
        style::warn("agent/skill に未同期の項目があります");
        eprintln!("{}", issues);
        eprintln!("  mt agent sync を実行して同期してください");
    }
    chezmoi_shared::run_chezmoi(&["apply"])
}
