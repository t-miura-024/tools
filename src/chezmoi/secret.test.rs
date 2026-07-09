use super::super::shared;

use tempfile::tempdir;

#[test]
fn test_validate_env_key_name_valid() {
    assert!(shared::validate_env_key_name("TAVILY_API_KEY").is_ok());
    assert!(shared::validate_env_key_name("A").is_ok());
    assert!(shared::validate_env_key_name("_PRIVATE_KEY").is_ok());
    assert!(shared::validate_env_key_name("OPENAI_API_KEY").is_ok());
    assert!(shared::validate_env_key_name("A_B_C_123").is_ok());
}

#[test]
fn test_validate_env_key_name_invalid_empty() {
    assert!(shared::validate_env_key_name("").is_err());
}

#[test]
fn test_validate_env_key_name_invalid_first_char() {
    assert!(shared::validate_env_key_name("1ABC").is_err());
    assert!(shared::validate_env_key_name("-KEY").is_err());
}

#[test]
fn test_validate_env_key_name_invalid_chars() {
    assert!(shared::validate_env_key_name("KEY-NAME").is_err());
    assert!(shared::validate_env_key_name("KEY.NAME").is_err());
    assert!(shared::validate_env_key_name("KEY NAME").is_err());
}

#[test]
fn test_normalize_secrets_plaintext() {
    let entries = vec![
        ("TAVILY_API_KEY".to_string(), "a".to_string()),
        ("FIRECRAWL_API_KEY".to_string(), "b".to_string()),
    ];
    let result = shared::normalize_secrets_plaintext(&entries);
    assert_eq!(
        result,
        "# Secrets（chezmoi で age 暗号化）\nexport TAVILY_API_KEY=a\nexport FIRECRAWL_API_KEY=b\n"
    );
}

#[test]
fn test_normalize_secrets_plaintext_empty_keeps_header() {
    let result = shared::normalize_secrets_plaintext(&[]);
    assert_eq!(result, "# Secrets（chezmoi で age 暗号化）\n");
}

#[test]
fn test_set_secret_entry_adds_new_key_and_normalizes() {
    let plaintext = "export TAVILY_API_KEY=a\n\n# firecrawl\nexport FIRECRAWL_API_KEY=b\n";
    let result = shared::set_secret_entry(plaintext, "NEW_KEY", "c");
    assert_eq!(
        result,
        "# Secrets（chezmoi で age 暗号化）\nexport TAVILY_API_KEY=a\nexport FIRECRAWL_API_KEY=b\nexport NEW_KEY=c\n"
    );
}

#[test]
fn test_set_secret_entry_overwrites_existing() {
    let plaintext = "export FOO=old\nexport BAR=keep\n";
    let result = shared::set_secret_entry(plaintext, "FOO", "new");
    assert_eq!(
        result,
        "# Secrets（chezmoi で age 暗号化）\nexport FOO=new\nexport BAR=keep\n"
    );
}

#[test]
fn test_delete_secret_entry() {
    let plaintext = "export FOO=1\nexport BAR=2\nexport BAZ=3\n";
    let result = shared::delete_secret_entry(plaintext, "BAR");
    assert_eq!(
        result,
        "# Secrets（chezmoi で age 暗号化）\nexport FOO=1\nexport BAZ=3\n"
    );
}

#[test]
fn test_delete_secret_entry_last_key_keeps_header() {
    let plaintext = "export ONLY=1\n";
    let result = shared::delete_secret_entry(plaintext, "ONLY");
    assert_eq!(result, "# Secrets（chezmoi で age 暗号化）\n");
}

#[test]
fn test_key_exists_in_plaintext() {
    let plaintext = "export EXISTING=foo\n# comment\n";
    assert!(shared::key_exists_in_plaintext(plaintext, "EXISTING"));
    assert!(!shared::key_exists_in_plaintext(plaintext, "MISSING"));
}

#[test]
fn test_key_exists_partial_match_avoided() {
    let plaintext = "export FOO_BAR=baz\n";
    assert!(!shared::key_exists_in_plaintext(plaintext, "FOO"));
    assert!(shared::key_exists_in_plaintext(plaintext, "FOO_BAR"));
}

#[test]
fn test_list_keys_in_plaintext() {
    let plaintext =
        "# firecrawl\nexport FIRECRAWL_API_KEY=x\n\n# takt\nexport TAKT_OPENCODE_API_KEY=y\n";
    let keys = shared::list_keys_in_plaintext(plaintext);
    assert_eq!(
        keys,
        vec![
            "FIRECRAWL_API_KEY".to_string(),
            "TAKT_OPENCODE_API_KEY".to_string()
        ]
    );
}

#[test]
fn test_list_keys_in_plaintext_skips_invalid_and_duplicates() {
    let plaintext = "export VALID=1\nexport 1BAD=2\nexport VALID=3\nnot an export\n";
    let keys = shared::list_keys_in_plaintext(plaintext);
    assert_eq!(keys, vec!["VALID".to_string()]);
}

#[test]
fn test_parse_chezmoi_toml_source_dir() {
    let guard = shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("HOME").ok();

    let tmp = tempdir().unwrap();
    let config_dir = tmp.path().join(".config").join("chezmoi");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join("chezmoi.toml"), "sourceDir = \"/custom/path\"\n").unwrap();

    unsafe {
        std::env::set_var("HOME", tmp.path().to_str().unwrap());
    }

    let result = shared::parse_chezmoi_toml_source_dir();
    assert_eq!(result, Some(std::path::PathBuf::from("/custom/path")));

    if let Some(v) = prev {
        unsafe {
            std::env::set_var("HOME", v);
        }
    }

    drop(guard);
}

#[test]
fn test_parse_chezmoi_toml_not_exists() {
    let guard = shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("HOME").ok();

    let tmp = tempdir().unwrap();
    unsafe {
        std::env::set_var("HOME", tmp.path().to_str().unwrap());
    }

    let result = shared::parse_chezmoi_toml_source_dir();
    assert_eq!(result, None);

    if let Some(v) = prev {
        unsafe {
            std::env::set_var("HOME", v);
        }
    }

    drop(guard);
}

#[test]
fn test_resolve_chezmoi_source_dir_env_var() {
    let guard = shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();

    unsafe {
        std::env::set_var(key, "/tmp/from-env");
    }
    let result = shared::resolve_chezmoi_source_dir().unwrap();
    assert_eq!(result, std::path::PathBuf::from("/tmp/from-env"));

    if let Some(v) = prev {
        unsafe {
            std::env::set_var(key, v);
        }
    } else {
        unsafe {
            std::env::remove_var(key);
        }
    }

    drop(guard);
}

#[test]
fn test_resolve_chezmoi_source_dir_default() {
    let guard = shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev_source = std::env::var("CHEZMOI_SOURCE_DIR").ok();
    let prev_home = std::env::var("HOME").ok();

    let tmp = tempdir().unwrap();
    unsafe {
        std::env::remove_var("CHEZMOI_SOURCE_DIR");
        std::env::set_var("HOME", tmp.path().to_str().unwrap());
    }

    let result = shared::resolve_chezmoi_source_dir().unwrap();
    assert_eq!(
        result,
        tmp.path().join("src").join("tools").join("chezmoi")
    );

    if let Some(v) = prev_source {
        unsafe {
            std::env::set_var("CHEZMOI_SOURCE_DIR", v);
        }
    }
    if let Some(v) = prev_home {
        unsafe {
            std::env::set_var("HOME", v);
        }
    }

    drop(guard);
}
