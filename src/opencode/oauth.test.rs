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
