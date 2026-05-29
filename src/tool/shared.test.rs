use super::*;

#[test]
fn test_find_manifest_root_from_current_repo() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let nested = root.join("src").join("cli");

    assert_eq!(find_manifest_root_from(&nested), Some(root));
}

#[test]
fn test_find_manifest_root_from_unrelated_dir() {
    assert_eq!(find_manifest_root_from(Path::new("/")), None);
}
