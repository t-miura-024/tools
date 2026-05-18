use dialoguer::Select;

use crate::cli::style;
use crate::git::{self, GitCommands, GitRepoCommands};
use crate::opencode::{self, OpencodeCommands, OpencodeOauthCommands, OpencodeWebCommands};

struct ScriptEntry {
    name: &'static str,
    category: &'static str,
}

const SCRIPTS: &[ScriptEntry] = &[
    ScriptEntry {
        name: "git repo create",
        category: "git",
    },
    ScriptEntry {
        name: "opencode oauth setup",
        category: "opencode",
    },
    ScriptEntry {
        name: "opencode web expose",
        category: "opencode",
    },
    ScriptEntry {
        name: "opencode web stop",
        category: "opencode",
    },
    ScriptEntry {
        name: "init",
        category: "config",
    },
];

pub fn run() -> anyhow::Result<()> {
    style::intro("mt: スクリプト選択");

    let mut sorted: Vec<&ScriptEntry> = SCRIPTS.iter().collect();
    sorted.sort_by(|a, b| a.category.cmp(b.category).then_with(|| a.name.cmp(b.name)));

    let selections: Vec<&str> = sorted.iter().map(|s| s.name).collect();

    let idx = Select::new()
        .with_prompt("実行するスクリプトを選択してください")
        .items(&selections)
        .default(0)
        .interact()?;

    let selected = sorted[idx];
    run_script(selected.name)?;

    Ok(())
}

fn run_script(name: &str) -> anyhow::Result<()> {
    match name {
        "git repo create" => git::run(GitCommands::Repo(GitRepoCommands::Create)),
        "opencode oauth setup" => opencode::run(OpencodeCommands::Oauth(
            OpencodeOauthCommands::Setup,
        )),
        "opencode web expose" => opencode::run(OpencodeCommands::Web(
            OpencodeWebCommands::Expose,
        )),
        "opencode web stop" => {
            opencode::run(OpencodeCommands::Web(OpencodeWebCommands::Stop))
        }
        "init" => crate::cli::init::run(),
        _ => anyhow::bail!("Unknown script: {}", name),
    }
}

#[cfg(test)]
mod tests {
    use super::SCRIPTS;

    #[test]
    fn test_scripts_are_unique() {
        let names: Vec<&str> = SCRIPTS.iter().map(|s| s.name).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names.len(), sorted.len(), "Script names must be unique");
    }

    #[test]
    fn test_script_name_format() {
        for entry in SCRIPTS {
            if entry.name != "init" {
                assert!(
                    entry.name.chars().any(|c| c == ' '),
                    "Script name '{}' should contain spaces (subcommand path)",
                    entry.name
                );
            }
        }
    }

    #[test]
    fn test_script_categories_separated() {
        let mut cats: Vec<&str> = SCRIPTS.iter().map(|s| s.category).collect();
        cats.sort();
        cats.dedup();
        assert!(cats.contains(&"git"));
        assert!(cats.contains(&"opencode"));
        assert!(cats.contains(&"config"));
    }
}
