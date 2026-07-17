use anyhow::Context;
use dialoguer::Confirm;

use crate::cli::style;
use crate::raycast::shared::{
    IMPORT_DEEPLINK, age_binary_present, decrypt_passphrase, open_deeplink, passphrase_path,
    raycast_app_present, rayconfig_path,
};

pub fn run() -> anyhow::Result<()> {
    style::intro("mt raycast restore: バックアップから Raycast 設定を復元");

    if !raycast_app_present() {
        anyhow::bail!("Raycast.app が見つかりません。/Applications にインストールしてください");
    }

    if !age_binary_present() {
        anyhow::bail!("age バイナリが見つかりません。`brew install age` で導入してください");
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
    let passphrase = decrypt_passphrase(&pp_path).context("passphrase の取得に失敗")?;

    let show = Confirm::new()
        .with_prompt("Passphrase を表示しますか？（端末に平文表示されます）")
        .default(false)
        .interact()
        .context("確認の入力に失敗")?;

    if show {
        println!();
        style::info(&format!("Passphrase: {}", passphrase.as_str()));
        println!();
    } else {
        style::info("Passphrase の表示をスキップしました");
    }

    style::info(&format!("バックアップファイル: {}", input.display()));

    style::info("Raycast Import 画面を開きます...");
    open_deeplink(IMPORT_DEEPLINK).context("Raycast Import 画面を開けませんでした")?;

    println!();
    style::info("Raycast で以下を実行してください:");
    println!("  1. Import Settings & Data が開いていることを確認");
    println!("  2. ファイル選択で上記パスの .rayconfig を選ぶ");
    println!("  3. Passphrase に表示された文字列を入力");
    println!("  4. インポートするカテゴリを選択して Import を実行");
    style::outro("done");
    Ok(())
}
