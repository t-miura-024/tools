use super::*;

#[test]
fn test_cleanup_commands_preview_before_force() {
    let brewfile = Path::new("/repo/manifests/Brewfile");
    let manifest_dir = Path::new("/repo/manifests");

    assert_eq!(
        brew_bundle_cleanup_preview_command(brewfile),
        ToolCommandSpec {
            program: "brew",
            args: vec![
                "bundle".into(),
                "cleanup".into(),
                "--file".into(),
                "/repo/manifests/Brewfile".into(),
            ],
            envs: vec![],
        }
    );
    assert_eq!(
        brew_bundle_cleanup_force_command(brewfile),
        ToolCommandSpec {
            program: "brew",
            args: vec![
                "bundle".into(),
                "cleanup".into(),
                "--force".into(),
                "--file".into(),
                "/repo/manifests/Brewfile".into(),
            ],
            envs: vec![],
        }
    );
    assert_eq!(
        mise_prune_preview_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "prune".into(),
                "--dry-run-code".into(),
                "--tools".into(),
                "-C".into(),
                "/repo/manifests".into(),
            ],
            envs: vec![],
        }
    );
    assert_eq!(
        mise_prune_tools_command(manifest_dir),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "prune".into(),
                "--tools".into(),
                "--yes".into(),
                "-C".into(),
                "/repo/manifests".into(),
            ],
            envs: vec![],
        }
    );
}

#[test]
fn test_npm_global_install_and_uninstall_use_mise_node() {
    let manifest_dir = Path::new("/repo/manifests");
    let packages = vec![
        NpmGlobalPackage {
            name: "agent-browser".to_string(),
            version: "latest".to_string(),
        },
        NpmGlobalPackage {
            name: "pnpm".to_string(),
            version: "9.0.0".to_string(),
        },
    ];

    assert_eq!(
        npm_global_install_command(manifest_dir, &packages),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "exec".into(),
                "-C".into(),
                "/repo/manifests".into(),
                "--".into(),
                "npm".into(),
                "install".into(),
                "--global".into(),
                "agent-browser@latest".into(),
                "pnpm@9.0.0".into(),
            ],
            envs: vec![],
        }
    );
    assert_eq!(
        npm_global_uninstall_command(
            manifest_dir,
            &["agent-browser".to_string(), "pnpm".to_string()],
        ),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "exec".into(),
                "-C".into(),
                "/repo/manifests".into(),
                "--".into(),
                "npm".into(),
                "uninstall".into(),
                "--global".into(),
                "agent-browser".into(),
                "pnpm".into(),
            ],
            envs: vec![],
        }
    );
}

#[test]
fn test_removable_npm_globals_protects_runtime_packages() {
    let installed = vec![
        "agent-browser".to_string(),
        "npm".to_string(),
        "corepack".to_string(),
        "old-tool".to_string(),
    ];
    let desired = vec!["agent-browser".to_string()];

    assert_eq!(
        removable_npm_global_packages(&installed, &desired),
        vec!["old-tool".to_string()]
    );
}
