use super::shared;

pub fn run(_args: &[&str]) -> anyhow::Result<()> {
    shared::run_chezmoi(&["apply"])
}
