use super::*;

#[test]
fn test_check_source_dir_config_accepts_env_var() {
    let _guard = super::super::shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("CHEZMOI_SOURCE_DIR").ok();
    unsafe {
        std::env::set_var("CHEZMOI_SOURCE_DIR", "/some/path");
    }
    assert!(check_source_dir_config().is_ok());

    unsafe {
        std::env::remove_var("CHEZMOI_SOURCE_DIR");
    }
    if let Some(v) = prev {
        unsafe {
            std::env::set_var("CHEZMOI_SOURCE_DIR", v);
        }
    }
}

#[test]
fn test_check_age_key_missing_file_fails() {
    let _guard = super::super::shared::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("HOME").ok();
    unsafe {
        std::env::set_var("HOME", "/nonexistent-chezmoi-doctor-test-home");
    }
    let result = check_age_key();
    assert!(result.is_err());
    if let Some(v) = prev {
        unsafe {
            std::env::set_var("HOME", v);
        }
    } else {
        unsafe {
            std::env::remove_var("HOME");
        }
    }
}
