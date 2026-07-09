use std::fs;

use anyhow::Context;

use crate::cli::style;
use crate::raycast::shared::{
    age_binary_present, chezmoi_source_dir, decrypt_passphrase, passphrase_path,
    raycast_binary_present, rayconfig_path, run_raycast_export,
};

pub fn run() -> anyhow::Result<()> {
    style::intro("mt raycast sync: Raycast 設定をエクスポートして chezmoi 管理");

    if !raycast_binary_present() {
        anyhow::bail!(
            "raycast CLI が見つかりません。Raycast アプリをインストールしてください"
        );
    }

    if !age_binary_present() {
        anyhow::bail!(
            "age バイナリが見つかりません。`mt tool install` または `brew install age` で導入してください"
        );
    }

    let source_dir = chezmoi_source_dir()?;
    if !source_dir.exists() {
        anyhow::bail!(
            "chezmoi ソースディレクトリが見つかりません: {}\n\
             `mt chezmoi init` で初期化してください",
            source_dir.display()
        );
    }

    let pp_path = passphrase_path()?;
    let passphrase =
        decrypt_passphrase(&pp_path).context("passphrase の取得に失敗")?;

    let output = rayconfig_path()?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("ディレクトリを作成できません: {}", parent.display()))?;
    }

    style::info("Raycast 設定をエクスポート中...");
    run_raycast_export(&passphrase, &output)
        .context("raycast export の実行に失敗")?;

    style::success(&format!("エクスポート完了: {}", output.display()));
    style::info("`git add chezmoi/dot_Raycast.rayconfig && git commit && git push` でバックアップを保存してください");
    style::outro("done");
    Ok(())
}
