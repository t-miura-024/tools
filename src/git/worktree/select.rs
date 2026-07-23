use crate::git::common;

use super::pick;

pub fn select() -> anyhow::Result<()> {
    common::ensure_inside_git_repo()?;
    common::ensure_fzf_available()?;

    let picked = pick::pick_worktree("worktree> ")?;
    println!("{}", picked.target);
    Ok(())
}
