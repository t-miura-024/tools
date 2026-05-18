use std::path::PathBuf;

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/Users/mt".to_string()))
}

pub fn oauth_config_path() -> PathBuf {
    home_dir().join(".config/opencode/ngrok-oauth.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub allowed_emails: Vec<String>,
}
