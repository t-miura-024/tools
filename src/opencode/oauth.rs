use std::fs;

use anyhow::Context;
use dialoguer::{Confirm, Input};

use crate::cli::style;
use crate::config;

fn read_config() -> Option<config::OAuthConfig> {
    let path = config::oauth_config_path();
    if !path.exists() {
        return None;
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn setup() -> anyhow::Result<()> {
    style::intro("ngrok Google OAuth 設定");

    let existing = read_config();

    if existing.is_some() {
        let overwrite = Confirm::new()
            .with_prompt("既に OAuth 設定が存在します。上書きしますか？")
            .default(false)
            .interact()?;
        if !overwrite {
            style::outro("設定を変更せずに終了します");
            return Ok(());
        }
    }

    let existing_ref = existing.as_ref();

    let client_id: String = Input::new()
        .with_prompt("Google OAuth クライアント ID")
        .default(
            existing_ref
                .map(|c| c.client_id.clone())
                .unwrap_or_default(),
        )
        .validate_with(|input: &String| -> Result<(), String> {
            if input.is_empty() {
                return Err("クライアント ID を入力してください".into());
            }
            if !input.ends_with(".apps.googleusercontent.com") {
                return Err(
                    "クライアント ID は .apps.googleusercontent.com で終わる必要があります".into(),
                );
            }
            Ok(())
        })
        .interact_text()?;

    let client_secret: String = Input::new()
        .with_prompt("Google OAuth クライアントシークレット")
        .default(
            existing_ref
                .map(|c| c.client_secret.clone())
                .unwrap_or_default(),
        )
        .validate_with(|input: &String| -> Result<(), String> {
            if input.is_empty() {
                return Err("クライアントシークレットを入力してください".into());
            }
            if !input.starts_with("GOCSPX-") {
                return Err("クライアントシークレットは GOCSPX- で始まる必要があります".into());
            }
            Ok(())
        })
        .interact_text()?;

    let emails_default = existing_ref
        .map(|c| c.allowed_emails.join(","))
        .unwrap_or_default();

    let emails_raw: String = Input::new()
        .with_prompt("許可するメールアドレス（カンマ区切りで複数可）")
        .default(emails_default)
        .validate_with(|input: &String| -> Result<(), String> {
            if input.is_empty() {
                return Err("少なくとも 1 つのメールアドレスを入力してください".into());
            }
            let emails: Vec<&str> = input
                .split(',')
                .map(|e| e.trim())
                .filter(|e| !e.is_empty())
                .collect();
            if emails.is_empty() {
                return Err("少なくとも 1 つのメールアドレスを入力してください".into());
            }
            for email in &emails {
                if !email.contains('@') {
                    return Err(format!(
                        "\"{}\" は有効なメールアドレスではありません",
                        email
                    ));
                }
            }
            Ok(())
        })
        .interact_text()?;

    let allowed_emails: Vec<String> = emails_raw
        .split(',')
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();

    let config = config::OAuthConfig {
        client_id,
        client_secret,
        allowed_emails,
    };

    let dir = config::home_dir().join(".config/opencode");
    fs::create_dir_all(&dir).context("設定ディレクトリの作成に失敗しました")?;

    let json = serde_json::to_string_pretty(&config)?;
    fs::write(config::oauth_config_path(), json + "\n")
        .context("設定ファイルの書き込みに失敗しました")?;

    style::success(&format!(
        "設定を保存しました: {}",
        config::oauth_config_path().display()
    ));
    style::outro("✅ OAuth 設定が完了しました");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oauth_config_serde_roundtrip() {
        let config = config::OAuthConfig {
            client_id: "123.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-xxxxx".into(),
            allowed_emails: vec!["a@b.com".into(), "c@d.com".into()],
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(json.contains("client_id"));
        assert!(json.contains("123.apps.googleusercontent.com"));

        let deserialized: config::OAuthConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.client_id, "123.apps.googleusercontent.com");
        assert_eq!(deserialized.allowed_emails.len(), 2);
    }
}
