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
fn test_build_secret_block_header() {
    let header = shared::build_secret_block_header("TEST_KEY", "2026-06-30");
    assert_eq!(header, "# TEST_KEY（2026-06-30）");
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
fn test_remove_existing_block_with_header() {
    let plaintext = "export KEEP=keepval\n# MY_KEY（2026-06-30）\n\nexport MY_KEY=secret\n";
    let result = shared::remove_existing_block(plaintext, "MY_KEY");
    assert!(!result.contains("MY_KEY"));
    assert!(result.contains("export KEEP=keepval"));
}

#[test]
fn test_remove_existing_block_standalone_export() {
    let plaintext = "export KEEP=keepval\nexport STANDALONE=val\n";
    let result = shared::remove_existing_block(plaintext, "STANDALONE");
    assert!(!result.contains("STANDALONE"));
    assert!(result.contains("export KEEP=keepval"));
}

#[test]
fn test_remove_existing_block_not_found() {
    let plaintext = "export FOO=bar\n";
    let result = shared::remove_existing_block(plaintext, "BAZ");
    assert_eq!(result.trim(), "export FOO=bar");
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
        unsafe { std::env::set_var("HOME", v); }
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
        unsafe { std::env::set_var("HOME", v); }
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
        unsafe { std::env::set_var(key, v); }
    } else {
        unsafe { std::env::remove_var(key); }
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
        unsafe { std::env::set_var("CHEZMOI_SOURCE_DIR", v); }
    }
    if let Some(v) = prev_home {
        unsafe { std::env::set_var("HOME", v); }
    }

    drop(guard);
}
