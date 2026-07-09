use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use dialoguer::{Confirm, Password, Select};

use super::shared;

pub struct SecretSetArgs<'a> {
    pub key: &'a str,
    pub dry_run: bool,
    pub skip_apply: bool,
}

pub struct SecretDeleteArgs {
    pub key: Option<String>,
    pub dry_run: bool,
    pub skip_apply: bool,
}

pub fn run_set(args: SecretSetArgs<'_>) -> anyhow::Result<()> {
    if let Err(msg) = shared::validate_env_key_name(args.key) {
        bail!("{}", msg);
    }

    let age_file = resolve_age_file()?;
    let public_key = get_age_public_key()?;
    let plaintext = decrypt_age(&age_file)?;

    let overwriting = shared::key_exists_in_plaintext(&plaintext, args.key);

    if overwriting {
        let prompt = format!("KEY '{}' は既に存在します。上書きしますか？", args.key);
        if !Confirm::new()
            .with_prompt(&prompt)
            .default(false)
            .interact()?
        {
            println!("キャンセルしました。");
            return Ok(());
        }
    }

    let value = Password::new()
        .with_prompt(format!("{} の値を入力", args.key))
        .with_confirmation("確認のためもう一度入力", "値が一致しません")
        .interact()?;

    let timestamp = chrono::Local::now().format("%Y-%m-%d").to_string();
    let header = shared::build_secret_block_header(args.key, &timestamp);
    let block = format!("{}\nexport {}={}\n", header, args.key, value);

    let new_plaintext = {
        let base = shared::remove_existing_block(&plaintext, args.key);
        shared::append_secret_block(&base, &block)
    };

    if args.dry_run {
        println!("=== dry-run: 書き込み内容 ===");
        print!("{}", new_plaintext);
        println!("=== dry-run 終了（ファイルは変更されていません） ===");
        return Ok(());
    }

    encrypt_age(new_plaintext.as_bytes(), &public_key, &age_file)?;
    println!("dot_zsh_secrets.age を '{}' で更新しました", args.key);
    maybe_apply(args.skip_apply)?;
    Ok(())
}

pub fn run_delete(args: SecretDeleteArgs) -> anyhow::Result<()> {
    let age_file = resolve_age_file()?;
    let public_key = get_age_public_key()?;
    let plaintext = decrypt_age(&age_file)?;

    let key = match args.key {
        Some(ref k) if !k.is_empty() => {
            if let Err(msg) = shared::validate_env_key_name(k) {
                bail!("{}", msg);
            }
            if !shared::key_exists_in_plaintext(&plaintext, k) {
                bail!("KEY '{}' は存在しません", k);
            }
            k.clone()
        }
        _ => select_key_to_delete(&plaintext)?,
    };

    let prompt = format!("KEY '{}' を削除しますか？", key);
    if !Confirm::new()
        .with_prompt(&prompt)
        .default(false)
        .interact()?
    {
        println!("キャンセルしました。");
        return Ok(());
    }

    let new_plaintext = shared::remove_existing_block(&plaintext, &key);
    let new_plaintext = {
        let mut s = new_plaintext.trim_end().to_string();
        if !s.is_empty() {
            s.push('\n');
        }
        s
    };

    if args.dry_run {
        println!("=== dry-run: 書き込み内容 ===");
        print!("{}", new_plaintext);
        println!("=== dry-run 終了（ファイルは変更されていません） ===");
        return Ok(());
    }

    encrypt_age(new_plaintext.as_bytes(), &public_key, &age_file)?;
    println!("dot_zsh_secrets.age から '{}' を削除しました", key);
    maybe_apply(args.skip_apply)?;
    Ok(())
}

fn select_key_to_delete(plaintext: &str) -> anyhow::Result<String> {
    let keys = shared::list_keys_in_plaintext(plaintext);
    if keys.is_empty() {
        bail!("削除可能な KEY がありません");
    }

    let selection = Select::new()
        .with_prompt("削除する KEY を選択")
        .items(&keys)
        .default(0)
        .interact()?;

    Ok(keys[selection].clone())
}

fn resolve_age_file() -> anyhow::Result<PathBuf> {
    let source_dir = shared::resolve_chezmoi_source_dir()?;
    let age_file = source_dir.join("dot_zsh_secrets.age");
    if !age_file.exists() {
        bail!(
            "{} が見つかりません（source dir: {}）",
            age_file.display(),
            source_dir.display()
        );
    }
    Ok(age_file)
}

fn maybe_apply(skip_apply: bool) -> anyhow::Result<()> {
    if !skip_apply
        && Confirm::new()
            .with_prompt("mt chezmoi apply を実行しますか？")
            .default(true)
            .interact()?
    {
        super::apply::run(&[])?;
    }
    Ok(())
}

fn get_age_public_key() -> anyhow::Result<String> {
    let key_path = age_identity_path()?;

    let output = Command::new("age-keygen")
        .arg("-y")
        .arg(&key_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("age-keygen の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("age-keygen が失敗しました: {}", stderr.trim());
    }

    let key = String::from_utf8(output.stdout)
        .context("age-keygen の出力が UTF-8 ではありません")?;
    Ok(key.trim().to_string())
}

fn decrypt_age(age_file: &Path) -> anyhow::Result<String> {
    let identity = age_identity_path()?;

    let output = Command::new("age")
        .arg("-d")
        .arg("-i")
        .arg(&identity)
        .arg(age_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("{} の復号に失敗しました", age_file.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{} の復号に失敗しました: {}",
            age_file.display(),
            stderr.trim()
        );
    }

    String::from_utf8(output.stdout)
        .context("復号された平文が UTF-8 ではありません")
}

fn encrypt_age(plaintext: &[u8], public_key: &str, dest_age_path: &Path) -> anyhow::Result<()> {
    let new_path = dest_age_path.with_extension("age.new");

    let mut child = Command::new("age")
        .arg("-r")
        .arg(public_key)
        .arg("-o")
        .arg(&new_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("age 暗号化プロセスの起動に失敗しました")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(plaintext)?;
    }

    let output = child.wait_with_output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&new_path);
        bail!("age 暗号化に失敗しました: {}", stderr.trim());
    }

    std::fs::rename(&new_path, dest_age_path)
        .context("暗号化ファイルの atomic rename に失敗しました")?;

    Ok(())
}

fn age_identity_path() -> anyhow::Result<std::path::PathBuf> {
    let path = shared::home_dir()?
        .join(".config")
        .join("chezmoi")
        .join("key.txt");

    if !path.exists() {
        bail!(
            "age 秘密鍵が見つかりません（{}）。先に age-keygen で生成してください",
            path.display()
        );
    }

    Ok(path)
}

#[cfg(test)]
#[path = "secret.test.rs"]
mod tests;
