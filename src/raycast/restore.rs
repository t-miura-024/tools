use anyhow::Context;

use crate::cli::style;
use crate::raycast::shared::{
    age_binary_present, decrypt_passphrase, passphrase_path,
    raycast_binary_present, rayconfig_path, run_raycast_import,
};

pub fn run() -> anyhow::Result<()> {
    style::intro("mt raycast restore: バックアップから Raycast 設定を復元");

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

    let input = rayconfig_path()?;
    if !input.exists() {
        anyhow::bail!(
            "バックアップファイルが見つかりません: {}\n\
             `mt raycast sync` でバックアップを作成するか、\
             `git checkout` で過去のバックアップを取得してください",
            input.display()
        );
    }

    let pp_path = passphrase_path()?;
    let passphrase =
        decrypt_passphrase(&pp_path).context("passphrase の取得に失敗")?;

    style::info("Raycast 設定をインポート中...");
    run_raycast_import(&passphrase, &input)
        .context("raycast import の実行に失敗")?;

    style::success("復元完了: Raycast 設定がインポートされました");
    style::outro("done");
    Ok(())
}
