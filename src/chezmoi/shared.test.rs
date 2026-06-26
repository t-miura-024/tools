use super::*;

#[test]
fn test_resolve_source_dir_uses_env_var() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();

    unsafe {
        std::env::set_var(key, "/tmp/from-env");
    }
    assert_eq!(resolve_source_dir(), Some("/tmp/from-env".to_string()));

    unsafe {
        std::env::remove_var(key);
    }
    assert_eq!(resolve_source_dir(), None);

    if let Some(v) = prev {
        unsafe {
            std::env::set_var(key, v);
        }
    }
}

#[test]
fn test_resolve_source_dir_treats_empty_as_unset() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = "CHEZMOI_SOURCE_DIR";
    let prev = std::env::var(key).ok();

    unsafe {
        std::env::set_var(key, "");
    }
    assert_eq!(resolve_source_dir(), None);

    if let Some(v) = prev {
        unsafe {
            std::env::set_var(key, v);
        }
    }
}

#[test]
fn test_default_source_dir_uses_home() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("HOME").ok();
    unsafe {
        std::env::set_var("HOME", "/Users/example");
    }
    assert_eq!(default_source_dir(), "/Users/example/src/tools/chezmoi");
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

#[test]
fn test_default_source_dir_falls_back_when_home_unset() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var("HOME").ok();
    unsafe {
        std::env::remove_var("HOME");
    }
    assert_eq!(default_source_dir(), "/src/tools/chezmoi");
    if let Some(v) = prev {
        unsafe {
            std::env::set_var("HOME", v);
        }
    }
}
