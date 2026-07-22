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

#[test]
fn test_read_bun_global_packages_parses_yml_and_sorts_alphabetically() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bun-global.yml");
    std::fs::write(
        &path,
        "packages:\n  pnpm:\n    version: latest\n  agent-browser:\n    version: latest\n  firecrawl:\n    version: 1.0.0\n",
    )
    .unwrap();

    let packages = read_bun_global_packages(&path).unwrap();

    assert_eq!(
        packages,
        vec![
            BunGlobalPackage {
                name: "agent-browser".to_string(),
                version: "latest".to_string(),
            },
            BunGlobalPackage {
                name: "firecrawl".to_string(),
                version: "1.0.0".to_string(),
            },
            BunGlobalPackage {
                name: "pnpm".to_string(),
                version: "latest".to_string(),
            },
        ]
    );
}

#[test]
fn test_read_bun_global_packages_treats_empty_packages_as_empty_list() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bun-global.yml");
    std::fs::write(&path, "packages: {}\n").unwrap();

    let packages = read_bun_global_packages(&path).unwrap();

    assert!(packages.is_empty());
}

#[test]
fn test_read_bun_global_packages_requires_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bun-global.yml");
    std::fs::write(&path, "packages:\n  pnpm: {}\n").unwrap();

    let error = read_bun_global_packages(&path).unwrap_err();
    let message = format!("{error:#}");
    assert!(
        message.contains("bun-global.yml"),
        "expected error to mention manifest path, got: {message}"
    );
}

#[test]
fn test_read_bun_global_packages_rejects_invalid_yaml() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bun-global.yml");
    std::fs::write(&path, "packages: : :\n").unwrap();

    let error = read_bun_global_packages(&path).unwrap_err();
    let message = format!("{error:#}");
    assert!(
        message.contains("YAML 解析"),
        "expected error to mention YAML parse failure, got: {message}"
    );
}
