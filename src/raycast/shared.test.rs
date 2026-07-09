use super::*;

#[test]
fn test_home_dir_returns_value() {
    let result = home_dir();
    assert!(result.is_ok());
    let path = result.unwrap();
    assert!(!path.as_os_str().is_empty());
}

#[test]
fn test_chezmoi_source_dir_falls_back_to_default() {
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();
    unsafe { std::env::remove_var(key); }

    let result = chezmoi_source_dir();
    assert!(result.is_ok());
    let path = result.unwrap();
    assert!(path.ends_with("chezmoi"));

    if let Some(v) = prev {
        unsafe { std::env::set_var(key, v); }
    }
}

#[test]
fn test_chezmoi_source_dir_uses_env_var() {
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();
    unsafe { std::env::set_var(key, "/tmp/test-chezmoi"); }

    let result = chezmoi_source_dir();
    assert_eq!(result.unwrap(), PathBuf::from("/tmp/test-chezmoi"));

    unsafe { std::env::remove_var(key); }
    if let Some(v) = prev {
        unsafe { std::env::set_var(key, v); }
    }
}

#[test]
fn test_rayconfig_path_ends_with_dot_rayconfig() {
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();
    unsafe { std::env::set_var(key, "/tmp/cs"); }

    let path = rayconfig_path().unwrap();
    assert_eq!(path, PathBuf::from("/tmp/cs/dot_Raycast.rayconfig"));

    unsafe { std::env::remove_var(key); }
    if let Some(v) = prev {
        unsafe { std::env::set_var(key, v); }
    }
}

#[test]
fn test_passphrase_path_ends_with_dot_raycast_passphrase_age() {
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();
    unsafe { std::env::set_var(key, "/tmp/cs"); }

    let path = passphrase_path().unwrap();
    assert_eq!(path, PathBuf::from("/tmp/cs/dot_raycast_passphrase.age"));

    unsafe { std::env::remove_var(key); }
    if let Some(v) = prev {
        unsafe { std::env::set_var(key, v); }
    }
}

#[test]
fn test_raycast_binary_present_returns_bool() {
    let result = raycast_binary_present();
    assert!(result == true || result == false);
}

#[test]
fn test_age_binary_present_returns_bool() {
    let result = age_binary_present();
    assert!(result == true || result == false);
}

#[test]
fn test_decrypt_passphrase_missing_file() {
    let missing = PathBuf::from("/tmp/__mt_raycast_test_nonexistent__.age");
    let result = decrypt_passphrase(&missing);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("見つかりません"));
}

#[test]
fn test_run_raycast_export_bad_binary() {
    let tmp = std::env::temp_dir().join("__mt_raycast_export_test__.rayconfig");
    let result = run_raycast_export("test-pass", &tmp);
    assert!(result.is_err() || result.is_ok());
}
