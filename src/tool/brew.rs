use crate::cli::style;
use crate::tool::shared::{Manifests, ToolCommandSpec, ensure_command, run_tool_command};

pub(super) fn upgrade() -> anyhow::Result<()> {
    style::intro("Homebrew パッケージ更新");

    let manifests = Manifests::discover()?;
    manifests.ensure_brewfile()?;
    ensure_command("brew")?;

    for command in brew_upgrade_commands() {
        run_tool_command(&command, &manifests.root)?;
    }

    style::outro("✅ Homebrew パッケージの更新が完了しました");
    Ok(())
}

fn brew_upgrade_commands() -> [ToolCommandSpec; 2] {
    [
        ToolCommandSpec::new("brew", ["update"]),
        ToolCommandSpec::new("brew", ["upgrade"]),
    ]
}

#[cfg(test)]
mod tests {
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
}
