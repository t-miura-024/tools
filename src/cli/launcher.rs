use std::io::Write;
use std::process::{Command, Stdio};

use anyhow::Context;

use crate::cli::style;
use crate::git::{self, GitCommands, GitRepoCommands, GitWorktreeCommands};
use crate::opencode::{self, OpencodeCommands, OpencodeOauthCommands, OpencodeWebCommands};
use crate::tool::{self, ToolBrewCommands, ToolCommands};

struct ScriptEntry {
    name: &'static str,
    category: &'static str,
    description: &'static str,
}

const CATEGORY_WIDTH: usize = 10;
const COMMAND_WIDTH: usize = 24;

const SCRIPTS: &[ScriptEntry] = &[
    ScriptEntry {
        name: "git repo create",
        category: "git",
        description: "GitHub リポジトリを対話的に作成",
    },
    ScriptEntry {
        name: "git worktree select",
        category: "git",
        description: "Git worktree を選択してパスを出力",
    },
    ScriptEntry {
        name: "opencode oauth setup",
        category: "opencode",
        description: "Google OAuth のセットアップ",
    },
    ScriptEntry {
        name: "opencode web expose",
        category: "opencode",
        description: "OpenCode Web を ngrok で公開",
    },
    ScriptEntry {
        name: "opencode web stop",
        category: "opencode",
        description: "OpenCode Web の公開を停止",
    },
    ScriptEntry {
        name: "tool install",
        category: "tool",
        description: "manifest からツールをインストール",
    },
    ScriptEntry {
        name: "tool verify",
        category: "tool",
        description: "Homebrew、mise、npm global の管理状態を検証",
    },
    ScriptEntry {
        name: "tool brew upgrade",
        category: "tool",
        description: "Homebrew パッケージを更新",
    },
    ScriptEntry {
        name: "init",
        category: "config",
        description: "mt コマンドの初期セットアップ",
    },
];

pub fn run() -> anyhow::Result<()> {
    style::intro("mt: スクリプト選択");

    let mut sorted: Vec<&ScriptEntry> = SCRIPTS.iter().collect();
    sorted.sort_by(|a, b| a.category.cmp(b.category).then_with(|| a.name.cmp(b.name)));

    let selected = select_script(&sorted)?;
    if let Some(name) = selected {
        run_script(&name)?;
    }

    Ok(())
}

fn run_script(name: &str) -> anyhow::Result<()> {
    match name {
        "git repo create" => git::run(GitCommands::Repo(GitRepoCommands::Create)),
        "git worktree select" => git::run(GitCommands::Worktree(GitWorktreeCommands::Select)),
        "opencode oauth setup" => {
            opencode::run(OpencodeCommands::Oauth(OpencodeOauthCommands::Setup))
        }
        "opencode web expose" => opencode::run(OpencodeCommands::Web(OpencodeWebCommands::Expose)),
        "opencode web stop" => opencode::run(OpencodeCommands::Web(OpencodeWebCommands::Stop)),
        "tool install" => tool::run(ToolCommands::Install),
        "tool verify" => tool::run(ToolCommands::Verify),
        "tool brew upgrade" => tool::run(ToolCommands::Brew(ToolBrewCommands::Upgrade)),
        "init" => crate::cli::init::run(),
        _ => anyhow::bail!("Unknown script: {}", name),
    }
}

fn select_script(scripts: &[&ScriptEntry]) -> anyhow::Result<Option<String>> {
    ensure_fzf()?;

    let header = format_script_header();
    let input = std::iter::once(header)
        .chain(
            scripts
                .iter()
                .map(|entry| format!("{}\t{}", format_script_row(entry), entry.name)),
        )
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";

    let mut child = Command::new("fzf")
        .args([
            "--delimiter",
            "\t",
            "--with-nth",
            "1",
            "--header-lines",
            "1",
            "--prompt",
            "script> ",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("fzf の起動に失敗しました")?;

    child
        .stdin
        .as_mut()
        .context("fzf の stdin を開けませんでした")?
        .write_all(input.as_bytes())
        .context("fzf への入力に失敗しました")?;

    let output = child
        .wait_with_output()
        .context("fzf の終了待ちに失敗しました")?;

    if !output.status.success() {
        return Ok(None);
    }

    let selected = String::from_utf8_lossy(&output.stdout);
    let name = selected
        .trim_end()
        .split('\t')
        .nth(1)
        .context("スクリプトの選択結果を解析できませんでした")?;

    Ok(Some(name.to_string()))
}

fn format_script_row(entry: &ScriptEntry) -> String {
    format!(
        "{:<category_width$}  {:<command_width$}  {}",
        entry.category,
        entry.name,
        entry.description,
        category_width = CATEGORY_WIDTH,
        command_width = COMMAND_WIDTH
    )
}

fn format_script_header() -> String {
    format!(
        "{:<category_width$}  {:<command_width$}  説明",
        "カテゴリ",
        "コマンド",
        category_width = CATEGORY_WIDTH,
        command_width = COMMAND_WIDTH
    )
}

fn ensure_fzf() -> anyhow::Result<()> {
    let status = Command::new("fzf")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if !matches!(status, Ok(status) if status.success()) {
        anyhow::bail!(
            "fzf がインストールされていません。brew install fzf などでインストールしてください"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SCRIPTS, format_script_header, format_script_row};

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
        assert!(cats.contains(&"tool"));
        assert!(cats.contains(&"config"));
    }

    #[test]
    fn test_scripts_have_descriptions() {
        for entry in SCRIPTS {
            assert!(
                !entry.description.trim().is_empty(),
                "Script '{}' should have a description",
                entry.name
            );
        }
    }

    #[test]
    fn test_format_script_row_uses_padded_columns() {
        let row = format_script_row(&SCRIPTS[0]);

        assert!(row.starts_with("git         git repo create"));
        assert!(row.contains("  GitHub リポジトリを対話的に作成"));
        assert!(!row.contains('\t'));
    }

    #[test]
    fn test_format_script_header_uses_padded_columns() {
        let header = format_script_header();

        assert!(header.starts_with("カテゴリ"));
        assert!(header.contains("コマンド"));
        assert!(header.ends_with("説明"));
        assert!(!header.contains('\t'));
    }
}
