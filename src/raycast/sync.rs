use anyhow::Context;
use dialoguer::Confirm;
use dialoguer::Input;

use crate::cli::style;
use crate::raycast::shared::{
    EXPORT_DEEPLINK, age_binary_present, chezmoi_source_dir, copy_file, decrypt_passphrase,
    find_latest_rayconfig_in_downloads, open_deeplink, passphrase_path, raycast_app_present,
    rayconfig_path,
};

pub fn run() -> anyhow::Result<()> {
    style::intro("mt raycast sync: Raycast 設定をエクスポートして chezmoi 管理");

    if !raycast_app_present() {
        anyhow::bail!("Raycast.app が見つかりません。/Applications にインストールしてください");
    }

    if !age_binary_present() {
        anyhow::bail!("age バイナリが見つかりません。`brew install age` で導入してください");
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

    style::info("Raycast Export 画面を開きます...");
    open_deeplink(EXPORT_DEEPLINK).context("Raycast Export 画面を開けませんでした")?;

    println!();
    style::info("Raycast で以下を実行してください:");
    println!("  1. Export Settings & Data が開いていることを確認");
    println!("  2. 必要に応じてカテゴリを選択");
    println!("  3. Passphrase に表示された文字列を入力し、Export を実行");
    println!("  4. 保存先を確認してください（通常 ~/Downloads/ 配下）");
    println!();

    let input_path_str: String = Input::new()
        .with_prompt("エクスポートされた .rayconfig ファイルのパス")
        .default(
            find_latest_rayconfig_in_downloads()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
        .interact_text()
        .context("パスの入力に失敗")?;

    let input_path = std::path::Path::new(&input_path_str);
    if !input_path.exists() {
        anyhow::bail!("ファイルが見つかりません: {}", input_path.display());
    }
    if !input_path_str.ends_with(".rayconfig") {
        let confirmed = Confirm::new()
            .with_prompt("拡張子が .rayconfig ではありません。続行しますか？")
            .default(false)
            .interact()
            .context("確認の入力に失敗")?;
        if !confirmed {
            anyhow::bail!("キャンセルしました");
        }
    }

    let dest = rayconfig_path()?;
    style::info(&format!(
        "{} -> {} にコピーします",
        input_path.display(),
        dest.display()
    ));
    copy_file(input_path, &dest).context("ファイルのコピーに失敗")?;

    style::success(&format!("エクスポート完了: {}", dest.display()));
    println!();
    style::info("Git でバックアップを保存:");
    println!("  cd ~/src/tools");
    println!("  git add chezmoi/dot_Raycast.rayconfig");
    println!("  git commit -m \"backup: Raycast settings $(date +%Y-%m-%d)\"");
    println!("  git push");
    style::outro("done");
    Ok(())
}
