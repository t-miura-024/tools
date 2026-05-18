use std::fs;

use anyhow::Context;
use dialoguer::Confirm;

use crate::cli::style;

pub fn run() -> anyhow::Result<()> {
    style::intro("mt コマンドセットアップ");

    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    let cargo_bin = format!("{}/.cargo/bin", home);
    let zshrc_path = format!("{}/.zshrc", home);
    let path_entry = "\nexport PATH=\"$HOME/.cargo/bin:$PATH\"\n".to_string();

    // Check if ~/.cargo/bin is in PATH
    let path = std::env::var("PATH").unwrap_or_default();
    if path.split(':').any(|p| p == cargo_bin) {
        style::info("~/.cargo/bin は既に PATH に含まれています");
        style::outro("セットアップは不要です");
        return Ok(());
    }

    style::info("~/.cargo/bin が PATH に含まれていません");
    style::info("Rust でインストールしたバイナリ（mt を含む）を実行するには、~/.cargo/bin を PATH に追加する必要があります");

    let add = Confirm::new()
        .with_prompt("~/.zshrc に PATH 設定を追加しますか？")
        .default(true)
        .interact()?;

    if !add {
        style::outro("スキップしました");
        return Ok(());
    }

    let content = fs::read_to_string(&zshrc_path).unwrap_or_default();

    let updated = content.trim_end().to_string() + &path_entry;
    fs::write(&zshrc_path, updated).context("~/.zshrc の書き込みに失敗しました")?;

    style::success("~/.zshrc に PATH 設定を追加しました");
    style::info("ターミナルを再起動するか、source ~/.zshrc を実行してください");
    style::outro("セットアップが完了しました");

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_path_contains_check() {
        let path = "/usr/local/bin:/usr/bin:/home/user/.cargo/bin:/bin";
        assert!(path.split(':').any(|p| p == "/home/user/.cargo/bin"));

        let path2 = "/usr/local/bin:/usr/bin:/bin";
        assert!(!path2.split(':').any(|p| p == "/home/user/.cargo/bin"));
    }
}
