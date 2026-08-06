use super::*;

#[test]
fn test_bun_upgrade_command_uses_mise_exec() {
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        bun_upgrade_command(manifest_dir, "tado"),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "exec".into(),
                "-C".into(),
                "/repo/manifests".into(),
                "--".into(),
                "bun".into(),
                "update".into(),
                "-g".into(),
                "tado".into(),
            ],
            envs: vec![],
        }
    );
}

#[test]
fn test_mise_reshim_command_uses_manifest_dir() {
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        mise_reshim_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec!["reshim".into(), "-C".into(), "/repo/manifests".into(),],
            envs: vec![],
        }
    );
}
