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
fn test_bun_global_install_and_uninstall_use_mise() {
    let manifest_dir = Path::new("/repo/manifests");
    let packages = vec![
        BunGlobalPackage {
            name: "agent-browser".to_string(),
            version: "latest".to_string(),
        },
        BunGlobalPackage {
            name: "pnpm".to_string(),
            version: "9.0.0".to_string(),
        },
    ];

    assert_eq!(
        bun_global_install_command(manifest_dir, &packages),
        ToolCommandSpec {
            program: "mise",
            args: vec![
                "exec".into(),
                "-C".into(),
                "/repo/manifests".into(),
                "--".into(),
                "bun".into(),
                "install".into(),
                "-g".into(),
                "agent-browser@latest".into(),
                "pnpm@9.0.0".into(),
            ],
            envs: vec![],
        }
    );
    assert_eq!(
        bun_global_uninstall_command(
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
                "bun".into(),
                "remove".into(),
                "-g".into(),
                "agent-browser".into(),
                "pnpm".into(),
            ],
            envs: vec![],
        }
    );
}

#[test]
fn test_removable_bun_globals_no_protected_packages() {
    let installed = vec![
        "agent-browser".to_string(),
        "old-tool".to_string(),
        "extra".to_string(),
    ];
    let desired = vec!["agent-browser".to_string()];

    assert_eq!(
        removable_bun_global_packages(&installed, &desired),
        vec!["old-tool".to_string(), "extra".to_string()]
    );
}

#[test]
fn test_removable_bun_globals_all_desired() {
    let installed = vec!["agent-browser".to_string(), "pnpm".to_string()];
    let desired = vec!["agent-browser".to_string(), "pnpm".to_string()];

    assert!(removable_bun_global_packages(&installed, &desired).is_empty());
}

#[test]
fn test_parse_bun_pm_ls_output_extracts_package_names() {
    let output =
        "/path/to/global/node_modules:\n  agent-browser@1.0.0\n  pnpm@9.0.0\n  firecrawl@latest\n";

    let packages = parse_bun_pm_ls_output(output);

    assert_eq!(
        packages,
        vec![
            "agent-browser".to_string(),
            "pnpm".to_string(),
            "firecrawl".to_string(),
        ]
    );
}

#[test]
fn test_parse_bun_pm_ls_output_with_tree_symbols() {
    let output = "/path/to/global/node_modules:\n├── agent-browser@1.0.0\n├── pnpm@9.0.0\n└── firecrawl@latest\n";

    let packages = parse_bun_pm_ls_output(output);

    assert_eq!(
        packages,
        vec![
            "agent-browser".to_string(),
            "pnpm".to_string(),
            "firecrawl".to_string(),
        ]
    );
}

#[test]
fn test_parse_bun_pm_ls_output_empty() {
    assert!(parse_bun_pm_ls_output("").is_empty());
}

#[test]
fn test_brew_trust_command_formats_correctly() {
    assert_eq!(
        brew_trust_command("yakitrak/yakitrak"),
        ToolCommandSpec {
            program: "brew",
            args: vec!["trust".into(), "yakitrak/yakitrak".into()],
            envs: vec![],
        }
    );
}

#[test]
fn test_brew_trust_extract_taps_from_brewfile() {
    let content =
        "tap \"adoptopenjdk/openjdk\"\ntap \"anomalyco/tap\"\nbrew \"fzf\"\ntap \"openclaw/tap\"\n";
    let re = Regex::new(r#"^tap\s+"([^"]+)""#).unwrap();
    let taps: Vec<String> = content
        .lines()
        .filter_map(|line| {
            re.captures(line)
                .and_then(|caps| caps.get(1))
                .map(|m| m.as_str().to_string())
        })
        .collect();

    assert_eq!(
        taps,
        vec![
            "adoptopenjdk/openjdk".to_string(),
            "anomalyco/tap".to_string(),
            "openclaw/tap".to_string(),
        ]
    );
}

#[test]
fn test_brew_trust_extract_taps_from_brewfile_empty_when_no_taps() {
    let content = "brew \"fzf\"\nbrew \"gh\"\ncask \"arc\"\n";
    let re = Regex::new(r#"^tap\s+"([^"]+)""#).unwrap();
    let taps: Vec<String> = content
        .lines()
        .filter_map(|line| {
            re.captures(line)
                .and_then(|caps| caps.get(1))
                .map(|m| m.as_str().to_string())
        })
        .collect();

    assert!(taps.is_empty());
}
