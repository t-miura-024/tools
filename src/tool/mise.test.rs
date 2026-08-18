use super::*;

#[test]
fn test_mise_upgrade_command_uses_manifest_dir() {
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        mise_upgrade_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec!["upgrade".into(), "-C".into(), "/repo/manifests".into(),],
            envs: vec![],
        }
    );
}
