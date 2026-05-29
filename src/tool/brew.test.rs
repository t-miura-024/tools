use super::*;

#[test]
fn test_brew_upgrade_commands_only_update_and_upgrade() {
    let commands = brew_upgrade_commands();

    assert_eq!(
        commands,
        [
            ToolCommandSpec {
                program: "brew",
                args: vec!["update".into()],
                envs: vec![],
            },
            ToolCommandSpec {
                program: "brew",
                args: vec!["upgrade".into()],
                envs: vec![],
            },
        ]
    );
}
