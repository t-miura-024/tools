use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;
use clap::{CommandFactory, Parser};
use dialoguer::Input;

use crate::Cli;
use crate::chezmoi::{self, ChezmoiCommands, SecretCommands};
use crate::cli::style;
use crate::vector::{self, VectorCommands};

struct ScriptEntry {
    name: String,
    category: String,
    description: String,
}

const CATEGORY_WIDTH: usize = 10;
const COMMAND_WIDTH: usize = 24;

/// ランチャーに表示しないコマンド（clap リーフのパス表記）
const EXCLUDED: &[&str] = &[
    "chezmoi init",
    "chezmoi status",
    "chezmoi add",
    "chezmoi edit",
    "chezmoi install-hook",
    "chezmoi uninstall-hook",
];

/// 既定カテゴリ（トップレベルコマンド名）に対する表示カテゴリの上書き
const CATEGORY_OVERRIDES: &[(&str, &str)] = &[
    ("self", "config"),
    ("doctor", "config"),
    ("agent", "config"),
];

/// 対話ラッパーを持つコマンド。clap 自動生成をスキップし専用ハンドラで実行する
fn is_wrapped(name: &str) -> bool {
    matches!(
        name,
        "vector ingest" | "vector search" | "chezmoi secret set"
    )
}

fn wrapped_entries() -> Vec<ScriptEntry> {
    vec![
        ScriptEntry {
            name: "vector ingest".to_string(),
            category: "vector".to_string(),
            description: "Markdown ファイルを Qdrant に投入（既定 config 使用）".to_string(),
        },
        ScriptEntry {
            name: "vector search".to_string(),
            category: "vector".to_string(),
            description: "Qdrant コレクションを検索（既定 config 使用）".to_string(),
        },
        ScriptEntry {
            name: "chezmoi secret set".to_string(),
            category: "dotfiles".to_string(),
            description: "dot_zsh_secrets.age に API キー等を追加・更新".to_string(),
        },
    ]
}

fn category_for(top: &str) -> String {
    CATEGORY_OVERRIDES
        .iter()
        .find(|(name, _)| *name == top)
        .map_or_else(|| top.to_string(), |(_, category)| (*category).to_string())
}

/// clap のコマンドツリーから全リーフサブコマンドを列挙する
fn leaf_entries() -> Vec<ScriptEntry> {
    fn collect(cmd: &clap::Command, path: &mut Vec<String>, out: &mut Vec<ScriptEntry>) {
        let subcommands: Vec<_> = cmd.get_subcommands().collect();
        if subcommands.is_empty() {
            if !path.is_empty() {
                let name = path.join(" ");
                out.push(ScriptEntry {
                    name,
                    category: category_for(&path[0]),
                    description: cmd
                        .get_about()
                        .map(|about| about.to_string())
                        .unwrap_or_default(),
                });
            }
            return;
        }
        for subcommand in subcommands {
            path.push(subcommand.get_name().to_string());
            collect(subcommand, path, out);
            path.pop();
        }
    }

    let mut entries = Vec::new();
    collect(&Cli::command(), &mut Vec::new(), &mut entries);
    entries
}

/// ランチャーに表示するスクリプト一覧（clap 自動生成 + 対話ラッパー）
fn script_entries() -> Vec<ScriptEntry> {
    let mut entries = Vec::new();
    for entry in leaf_entries() {
        if EXCLUDED.contains(&entry.name.as_str()) || is_wrapped(&entry.name) {
            continue;
        }
        entries.push(entry);
    }
    entries.extend(wrapped_entries());
    entries
}

pub fn run() -> anyhow::Result<()> {
    style::intro("mt: スクリプト選択");

    let entries = script_entries();
    let mut sorted: Vec<&ScriptEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| a.name.cmp(&b.name))
    });

    let selected = select_script(&sorted)?;
    if let Some(name) = selected {
        run_script(&name)?;
    }

    Ok(())
}

fn run_script(name: &str) -> anyhow::Result<()> {
    match name {
        "vector ingest" => return run_vector_ingest(),
        "vector search" => return run_vector_search(),
        "chezmoi secret set" => return run_chezmoi_secret_set(),
        _ => {}
    }

    let tokens = std::iter::once("mt".to_string()).chain(name.split(' ').map(str::to_string));
    let cli = Cli::try_parse_from(tokens)
        .map_err(|err| anyhow::anyhow!("スクリプト {} の実行に失敗しました: {}", name, err))?;
    let command = cli.command.context("コマンドが指定されていません")?;
    crate::dispatch(command)
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

fn run_chezmoi_secret_set() -> anyhow::Result<()> {
    let key: String = Input::new()
        .with_prompt("環境変数名（例: TAVILY_API_KEY）")
        .interact_text()
        .context("KEY の入力に失敗しました")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        style::info("KEY が空のためキャンセルしました");
        return Ok(());
    }
    chezmoi::run(ChezmoiCommands::Secret(SecretCommands::Set {
        key,
        dry_run: false,
        no_apply: false,
    }))
}

fn default_vector_config_path() -> PathBuf {
    PathBuf::from("vector.config.toml")
}

fn run_vector_ingest() -> anyhow::Result<()> {
    let config = default_vector_config_path();
    if !config.exists() {
        anyhow::bail!(
            "vector.config.toml が見つかりません（cwd: {}）。`mt vector ingest --config <path>` を直接実行するか、リポジトリルートで vector.config.toml を作成してください",
            config
                .canonicalize()
                .unwrap_or_else(|_| config.clone())
                .display()
        );
    }
    vector::run(VectorCommands::Ingest { config })
}

fn run_vector_search() -> anyhow::Result<()> {
    let config = default_vector_config_path();
    if !config.exists() {
        anyhow::bail!(
            "vector.config.toml が見つかりません（cwd: {}）。`mt vector search --config <path> --query <text>` を直接実行するか、リポジトリルートで vector.config.toml を作成してください",
            config
                .canonicalize()
                .unwrap_or_else(|_| config.clone())
                .display()
        );
    }
    let query: String = Input::new()
        .with_prompt("検索クエリ")
        .interact_text()
        .context("検索クエリの入力に失敗しました")?;
    let query = query.trim().to_string();
    if query.is_empty() {
        style::info("クエリが空のため検索をスキップしました");
        return Ok(());
    }
    vector::run(VectorCommands::Search { config, query })
}

#[cfg(test)]
#[path = "launcher.test.rs"]
mod tests;
