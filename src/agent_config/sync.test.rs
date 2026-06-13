use super::*;
use std::fs;
use tempfile::TempDir;

#[test]
fn test_sync_dir_with_delete_basic() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("file1.txt"), "content1").unwrap();
    fs::write(src.path().join("file2.txt"), "content2").unwrap();

    sync_dir_with_delete(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("file1.txt").exists());
    assert!(dest.path().join("file2.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("file1.txt")).unwrap(),
        "content1"
    );
}

#[test]
fn test_sync_dir_with_delete_removes_extra_files() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("file1.txt"), "content1").unwrap();
    fs::write(dest.path().join("file1.txt"), "old").unwrap();
    fs::write(dest.path().join("extra.txt"), "extra").unwrap();

    sync_dir_with_delete(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("file1.txt").exists());
    assert!(!dest.path().join("extra.txt").exists());
}

#[test]
fn test_sync_dir_with_delete_nested() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::create_dir_all(src.path().join("subdir")).unwrap();
    fs::write(src.path().join("subdir/file.txt"), "nested").unwrap();

    sync_dir_with_delete(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("subdir/file.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("subdir/file.txt")).unwrap(),
        "nested"
    );
}

#[test]
fn test_sync_dir_with_delete_removes_extra_dirs() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("file.txt"), "content").unwrap();
    fs::create_dir_all(dest.path().join("extra_dir")).unwrap();
    fs::write(dest.path().join("extra_dir/file.txt"), "extra").unwrap();

    sync_dir_with_delete(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("file.txt").exists());
    assert!(!dest.path().join("extra_dir").exists());
}

#[test]
fn test_sync_dir_additive_basic() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("file1.txt"), "content1").unwrap();
    fs::write(src.path().join("file2.txt"), "content2").unwrap();

    sync_dir_additive(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("file1.txt").exists());
    assert!(dest.path().join("file2.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("file1.txt")).unwrap(),
        "content1"
    );
}

#[test]
fn test_sync_dir_additive_preserves_existing_files() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("managed.txt"), "managed").unwrap();
    fs::write(dest.path().join("user.txt"), "user-managed").unwrap();
    fs::write(dest.path().join("managed.txt"), "old").unwrap();

    sync_dir_additive(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("user.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("user.txt")).unwrap(),
        "user-managed"
    );
    assert_eq!(
        fs::read_to_string(dest.path().join("managed.txt")).unwrap(),
        "managed"
    );
}

#[test]
fn test_sync_dir_additive_preserves_existing_dirs() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::write(src.path().join("managed.txt"), "managed").unwrap();
    fs::create_dir_all(dest.path().join("user_dir")).unwrap();
    fs::write(dest.path().join("user_dir/file.txt"), "user").unwrap();

    sync_dir_additive(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("managed.txt").exists());
    assert!(dest.path().join("user_dir").exists());
    assert!(dest.path().join("user_dir/file.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("user_dir/file.txt")).unwrap(),
        "user"
    );
}

#[test]
fn test_sync_dir_additive_nested() {
    let src = TempDir::new().unwrap();
    let dest = TempDir::new().unwrap();

    fs::create_dir_all(src.path().join("subdir")).unwrap();
    fs::write(src.path().join("subdir/file.txt"), "nested").unwrap();

    sync_dir_additive(src.path(), dest.path()).unwrap();

    assert!(dest.path().join("subdir/file.txt").exists());
    assert_eq!(
        fs::read_to_string(dest.path().join("subdir/file.txt")).unwrap(),
        "nested"
    );
}
