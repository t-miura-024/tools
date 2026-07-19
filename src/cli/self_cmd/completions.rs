use std::io;

use clap::CommandFactory;
use clap_complete::{generate, Shell};

use crate::cli::style;

pub fn run(shell: Shell) -> anyhow::Result<()> {
    let mut cmd = crate::Cli::command();
    generate(shell, &mut cmd, "mt", &mut io::stdout());
    Ok(())
}

pub fn write_completion_script() -> anyhow::Result<()> {
    let target_dir = std::path::PathBuf::from("/opt/homebrew/share/zsh/site-functions");
    let target_file = target_dir.join("_mt");

    std::fs::create_dir_all(&target_dir)
        .map_err(|e| anyhow::anyhow!("ディレクトリ {} を作成できませんでした: {}", target_dir.display(), e))?;

    let mut script = Vec::new();
    let mut cmd = crate::Cli::command();
    generate(Shell::Zsh, &mut cmd, "mt", &mut script);

    if let Ok(existing) = std::fs::read_to_string(&target_file) {
        let existing_str = String::from_utf8_lossy(&script);
        if existing == existing_str {
            style::success("補完スクリプトは既に最新です");
            return Ok(());
        }
    }

    std::fs::write(&target_file, &script)
        .map_err(|e| anyhow::anyhow!("ファイル {} を書き込めませんでした: {}", target_file.display(), e))?;

    style::success(&format!(
        "補完スクリプトを {} に配置しました",
        target_file.display()
    ));
    Ok(())
}
