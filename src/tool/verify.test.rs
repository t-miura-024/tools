use super::*;

#[test]
fn test_verify_commands_do_not_upgrade_or_install() {
    let brewfile = Path::new("/repo/manifests/Brewfile");
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        brew_bundle_check_command(brewfile),
        ToolCommandSpec {
            program: "brew",
            args: vec![
                "bundle".into(),
                "check".into(),
                "--no-upgrade".into(),
                "--file".into(),
                "/repo/manifests/Brewfile".into(),
            ],
            envs: vec![("HOMEBREW_NO_AUTO_UPDATE", "1")],
        }
    );
    assert_eq!(
        mise_verify_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "install".into(),
                "--dry-run-code".into(),
                "-C".into(),
                "/repo/manifests".into(),
            ],
            envs: vec![],
        }
    );
}

#[test]
fn test_bun_global_list_command_uses_mise() {
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        bun_global_list_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "exec".into(),
                "-C".into(),
                "/repo/manifests".into(),
                "--".into(),
                "bun".into(),
                "pm".into(),
                "ls".into(),
                "-g".into(),
                "--all".into(),
            ],
            envs: vec![],
        }
    );
}
