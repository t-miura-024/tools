use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;
use dialoguer::Input;

use crate::agent_config::{self, AgentConfigCommands};
use crate::cli::self_cmd::{self, SelfCommands};
use crate::cli::style;
use crate::git::{self, GitCommands, GitRepoCommands, GitWorktreeCommands};
use crate::opencode::{self, OpencodeCommands, OpencodeOauthCommands, OpencodeWebCommands};
use crate::tool::{self, ToolBrewCommands, ToolCommands};
use crate::vector::{self, VectorCommands};

struct ScriptEntry {
    name: &'static str,
    category: &'static str,
    description: &'static str,
}

const CATEGORY_WIDTH: usize = 10;
const COMMAND_WIDTH: usize = 24;

const SCRIPTS: &[ScriptEntry] = &[
    ScriptEntry {
        name: "agent-config sync",
        category: "agent",
        description: "全プラットフォームに設定を同期",
    },
    ScriptEntry {
        name: "agent-config bootstrap",
        category: "agent",
        description: "初期セットアップ（同期 + post-commit hook 設置）",
    },
    ScriptEntry {
        name: "git repo create",
        category: "git",
        description: "GitHub リポジトリを対話的に作成",
    },
    ScriptEntry {
        name: "git repo select",
        category: "git",
        description: "~/doc, ~/src から親 Git リポジトリを選択してパスを出力（worktree は対象外）",
    },
    ScriptEntry {
        name: "git worktree select",
        category: "git",
        description: "Git worktree を選択してパスを出力",
    },
    ScriptEntry {
        name: "git worktree create",
        category: "git",
        description: "Git worktree と新規ブランチを対話的に作成",
    },
    ScriptEntry {
        name: "git worktree delete",
        category: "git",
        description: "Git worktree を対話的に削除（多段ガード + 復旧ヒント）",
    },
    ScriptEntry {
        name: "git sync",
        category: "git",
        description: "現在のブランチを upstream 同期 + target を pull で取り込み",
    },
    ScriptEntry {
        name: "git ship",
        category: "git",
        description: "自身のブランチで commit & push → target に no-ff マージ & push",
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
        name: "vector ingest",
        category: "vector",
        description: "Markdown ファイルを Qdrant に投入",
    },
    ScriptEntry {
        name: "vector search",
        category: "vector",
        description: "Qdrant コレクションをベクトル検索",
    },
    ScriptEntry {
        name: "self install",
        category: "config",
        description: "mt バイナリのビルドとシェル環境整備",
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
        "agent-config sync" => agent_config::run(AgentConfigCommands::Sync),
        "agent-config bootstrap" => agent_config::run(AgentConfigCommands::Bootstrap),
        "git repo create" => git::run(GitCommands::Repo(GitRepoCommands::Create)),
        "git repo select" => git::run(GitCommands::Repo(GitRepoCommands::Select)),
        "git worktree select" => git::run(GitCommands::Worktree(GitWorktreeCommands::Select)),
        "git worktree create" => git::run(GitCommands::Worktree(GitWorktreeCommands::Create)),
        "git worktree delete" => git::run(GitCommands::Worktree(GitWorktreeCommands::Delete {
            force: false,
        })),
        "git sync" => git::run(GitCommands::Sync { target: None }),
        "git ship" => git::run(GitCommands::Ship {
            target: None,
            message: None,
        }),
        "opencode oauth setup" => {
            opencode::run(OpencodeCommands::Oauth(OpencodeOauthCommands::Setup))
        }
        "opencode web expose" => opencode::run(OpencodeCommands::Web(OpencodeWebCommands::Expose)),
        "opencode web stop" => opencode::run(OpencodeCommands::Web(OpencodeWebCommands::Stop)),
        "tool install" => tool::run(ToolCommands::Install),
        "tool verify" => tool::run(ToolCommands::Verify),
        "tool brew upgrade" => tool::run(ToolCommands::Brew(ToolBrewCommands::Upgrade)),
        "vector ingest" => run_vector_ingest(),
        "vector search" => run_vector_search(),
        "self install" => self_cmd::run(SelfCommands::Install),
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
