use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use dialoguer::{Input, Select};

use crate::cli::style;
use crate::config;

pub fn create() -> anyhow::Result<()> {
    style::intro("GitHub リポジトリ作成");

    let name: String = Input::new()
        .with_prompt("リポジトリ名")
        .validate_with(|input: &String| -> Result<(), &str> {
            if input.is_empty() {
                return Err("リポジトリ名を入力してください");
            }
            if !input
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
            {
                return Err("リポジトリ名に使える文字: a-z, 0-9, _, ., -");
            }
            Ok(())
        })
        .interact_text()?;

    let placements: Vec<&str> = config::REPO_ROOTS.iter().rev().copied().collect();
    let placement_idx = Select::new()
        .with_prompt("配置先")
        .items(&placements)
        .default(0)
        .interact()?;
    let placement = placements[placement_idx];

    let visibility_options = ["Private", "Public"];
    let vis_idx = Select::new()
        .with_prompt("公開設定")
        .items(&visibility_options)
        .default(0)
        .interact()?;
    let visibility = if vis_idx == 0 { "private" } else { "public" };

    let description: String = Input::new()
        .with_prompt("説明 (省略可)")
        .allow_empty(true)
        .interact_text()?;

    let dir = config::home_dir().join(placement).join(&name);

    if dir.exists() {
        style::error(&format!("ディレクトリが既に存在します: {}", dir.display()));
        style::outro("中止しました");
        return Ok(());
    }

    if !check_gh_auth()? {
        style::error("gh CLI が認証されていません。\n  gh auth login を実行してください");
        style::outro("中止しました");
        return Ok(());
    }

    let spinner = style::spinner("ローカルリポジトリをセットアップ中...");
    match setup_local_repo(&dir, &name) {
        Ok(()) => {
            spinner.finish_with_message("ローカルセットアップ完了");
        }
        Err(e) => {
            spinner.finish_with_message("ローカルセットアップ失敗");
            style::error(&e.to_string());
            style::outro("中止しました");
            return Ok(());
        }
    }

    accept_github_host_key()?;

    let spinner = style::spinner("GitHub リポジトリを作成・push 中...");
    match create_github_repo(&name, visibility, &description, &dir) {
        Ok(()) => {
            spinner.finish_with_message("GitHub リポジトリを作成しました");
        }
        Err(e) => {
            spinner.finish_with_message("GitHub リポジトリ作成失敗");
            style::error(&e.to_string());
            style::outro("中止しました");
            return Ok(());
        }
    }

    style::outro(&format!("✅ {} を作成しました: {}", name, dir.display()));
    Ok(())
}

fn check_gh_auth() -> anyhow::Result<bool> {
    let status = Command::new("gh")
        .args(["auth", "status"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context("gh コマンドの実行に失敗しました")?;
    Ok(status.success())
}

fn setup_local_repo(dir: &PathBuf, _name: &str) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;

    let status = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git init に失敗しました");
    }

    fs::write(dir.join("README.md"), format!("# {}\n", _name))?;
    fs::write(dir.join(".gitignore"), "")?;

    let status = Command::new("git")
        .args(["add", "."])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git add に失敗しました");
    }

    let status = Command::new("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(dir)
        .status()?;
    if !status.success() {
        bail!("git commit に失敗しました");
    }

    Ok(())
}

fn accept_github_host_key() -> anyhow::Result<()> {
    let _ = Command::new("ssh")
        .args([
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-T",
            "git@github.com",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    Ok(())
}

fn create_github_repo(
    name: &str,
    visibility: &str,
    description: &str,
    dir: &PathBuf,
) -> anyhow::Result<()> {
    let vis_flag = format!("--{}", visibility);
    let mut args = vec![
        "repo",
        "create",
        name,
        &vis_flag[..],
        "--source=.",
        "--push",
    ];
    if !description.is_empty() {
        args.push("--description");
        args.push(description);
    }

    let status = Command::new("gh").args(&args).current_dir(dir).status()?;
    if !status.success() {
        bail!("gh repo create に失敗しました");
    }

    Ok(())
}

struct RepoEntry {
    category: String,
    name: String,
    path: PathBuf,
    group: String,
    is_worktree: bool,
    head_info: HeadInfo,
}

enum HeadInfo {
    Branch(String),
    Detached(String),
    #[allow(dead_code)]
    Bare,
    Unknown,
}

impl RepoEntry {
    fn label(&self) -> String {
        match &self.head_info {
            HeadInfo::Branch(branch) => format!("[{branch}]"),
            HeadInfo::Detached(sha) => format!("({sha})"),
            HeadInfo::Bare => "(bare)".to_string(),
            HeadInfo::Unknown => "(?)".to_string(),
        }
    }
}

pub fn select() -> anyhow::Result<()> {
    let home = config::home_dir();
    let roots: Vec<PathBuf> = config::REPO_ROOTS.iter().map(|r| home.join(r)).collect();

    let entries = discover_repos(&roots)?;
    if entries.is_empty() {
        bail!("~/doc, ~/src 配下に Git リポジトリが見つかりませんでした");
    }

    let sorted = group_and_sort(entries);
    let input = format_repo_rows(&sorted);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--no-tac",
            "--delimiter",
            "\t",
            "--with-nth",
            "1,2,3,4",
            "--header-lines",
            "1",
            "--prompt",
            "repo> ",
        ],
    )?;

    let path = parse_repo_selection(&selected)?;
    println!("{path}");
    Ok(())
}

fn discover_repos(roots: &[PathBuf]) -> anyhow::Result<Vec<RepoEntry>> {
    let mut entries = Vec::new();

    for (idx, root) in roots.iter().enumerate() {
        let category = config::REPO_ROOTS[idx];
        if !root.exists() {
            continue;
        }

        for dir_entry in fs::read_dir(root)
            .with_context(|| format!("{} の読み取りに失敗しました", root.display()))?
        {
            let dir_entry = dir_entry?;
            let path = dir_entry.path();
            if !path.is_dir() {
                continue;
            }

            let Some(entry) = inspect_repo_dir(&path, category) else {
                continue;
            };
            entries.push(entry);
        }
    }

    Ok(entries)
}

fn inspect_repo_dir(path: &Path, category: &str) -> Option<RepoEntry> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())?;

    let git_path = path.join(".git");
    let (group, is_worktree) = if git_path.is_dir() {
        (name.clone(), false)
    } else if git_path.is_file() {
        let content = fs::read_to_string(&git_path).ok()?;
        let gitdir = parse_git_pointer(&content)?;
        let main_git_dir = Path::new(&gitdir)
            .ancestors()
            .nth(3)
            .map(|p| p.to_path_buf())?;
        let group = main_git_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| name.clone());
        (group, true)
    } else {
        return None;
    };

    let head_info = read_head_info(&git_path);

    Some(RepoEntry {
        category: category.to_string(),
        name,
        path: path.to_path_buf(),
        group,
        is_worktree,
        head_info,
    })
}

fn parse_git_pointer(content: &str) -> Option<String> {
    content
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("gitdir: "))
        .map(|s| s.trim().to_string())
}

fn read_head_info(git_path: &Path) -> HeadInfo {
    let head_path = if git_path.is_dir() {
        git_path.join("HEAD")
    } else if git_path.is_file() {
        let content = fs::read_to_string(git_path).ok();
        let gitdir = content.as_deref().and_then(parse_git_pointer);
        match gitdir {
            Some(dir) => PathBuf::from(dir).join("HEAD"),
            None => return HeadInfo::Unknown,
        }
    } else {
        return HeadInfo::Unknown;
    };

    let content = match fs::read_to_string(&head_path) {
        Ok(c) => c,
        Err(_) => return HeadInfo::Unknown,
    };

    let trimmed = content.trim();
    if let Some(branch) = trimmed.strip_prefix("ref: refs/heads/") {
        return HeadInfo::Branch(branch.to_string());
    }
    if trimmed.len() == 40 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return HeadInfo::Detached(trimmed.chars().take(7).collect());
    }
    HeadInfo::Unknown
}

fn group_and_sort(entries: Vec<RepoEntry>) -> Vec<RepoEntry> {
    let category_rank = |c: &str| {
        config::REPO_ROOTS
            .iter()
            .position(|r| *r == c)
            .unwrap_or(usize::MAX)
    };
    let mut sorted = entries;
    sorted.sort_by(|a, b| {
        category_rank(&a.category)
            .cmp(&category_rank(&b.category))
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.is_worktree.cmp(&b.is_worktree))
            .then_with(|| a.name.cmp(&b.name))
    });
    sorted
}

fn format_repo_rows(entries: &[RepoEntry]) -> String {
    let mut lines = vec![format_repo_header(entries)];
    for entry in entries {
        let worktree_name = if entry.is_worktree {
            entry.name.as_str()
        } else {
            ""
        };
        let path = entry.path.display().to_string();
        let padded = format_padded_row(
            &entry.category,
            &entry.group,
            worktree_name,
            &entry.label(),
            entries,
        );
        lines.push(format!("{padded}\t{path}"));
    }
    lines.join("\n") + "\n"
}

fn format_repo_header(entries: &[RepoEntry]) -> String {
    format_padded_row("category", "group", "worktree", "branch", entries)
}

fn format_padded_row(
    category: &str,
    group: &str,
    worktree: &str,
    branch: &str,
    entries: &[RepoEntry],
) -> String {
    let widths = column_widths(entries);
    format!(
        "{:<w_cat$}  {:<w_grp$}  {:<w_wt$}  {:<w_br$}",
        category,
        group,
        worktree,
        branch,
        w_cat = widths.0,
        w_grp = widths.1,
        w_wt = widths.2,
        w_br = widths.3
    )
}

fn column_widths(entries: &[RepoEntry]) -> (usize, usize, usize, usize) {
    let mut w_category = "category".chars().count();
    let mut w_group = "group".chars().count();
    let mut w_worktree = "worktree".chars().count();
    let mut w_branch = "branch".chars().count();

    for entry in entries {
        w_category = w_category.max(entry.category.chars().count());
        w_group = w_group.max(entry.group.chars().count());
        let worktree = if entry.is_worktree {
            entry.name.as_str()
        } else {
            ""
        };
        w_worktree = w_worktree.max(worktree.chars().count());
        w_branch = w_branch.max(entry.label().chars().count());
    }

    (w_category, w_group, w_worktree, w_branch)
}

fn parse_repo_selection(selected: &str) -> anyhow::Result<String> {
    let trimmed = selected.trim_end();
    let target = trimmed
        .rsplit('\t')
        .next()
        .context("リポジトリの選択結果を解析できませんでした")?;
    if target.is_empty() || target == trimmed {
        bail!("リポジトリの選択結果を解析できませんでした");
    }
    Ok(target.to_string())
}

fn run_fzf(input: String, args: &[&str]) -> anyhow::Result<String> {
    let mut child = Command::new("fzf")
        .env_remove("FZF_DEFAULT_OPTS")
        .args(args)
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
        std::process::exit(output.status.code().unwrap_or(1));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
#[path = "repo.test.rs"]
mod tests;
