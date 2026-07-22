use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};

use crate::config;

pub struct RepoEntry {
    pub category: String,
    pub name: String,
    pub path: PathBuf,
    pub head_info: HeadInfo,
}

pub enum HeadInfo {
    Branch(String),
    Detached(String),
    #[allow(dead_code)]
    Bare,
    Unknown,
}

impl RepoEntry {
    pub fn label(&self) -> String {
        match &self.head_info {
            HeadInfo::Branch(branch) => format!("[{branch}]"),
            HeadInfo::Detached(sha) => format!("({sha})"),
            HeadInfo::Bare => "(bare)".to_string(),
            HeadInfo::Unknown => "(?)".to_string(),
        }
    }

    /// リポジトリの表示文字列（`category/name [branch]` 形式）を返す。
    pub fn display_name(&self) -> String {
        format!("{}/{} {}", self.category, self.name, self.label())
    }
}

pub fn select_repo() -> anyhow::Result<PathBuf> {
    let home = config::home_dir();
    let roots: Vec<PathBuf> = config::REPO_ROOTS.iter().map(|r| home.join(r)).collect();

    let entries = discover_repos(&roots)?;
    if entries.is_empty() {
        bail!(
            "~/doc, ~/src 配下に親 Git リポジトリが見つかりませんでした（worktree は対象外です）"
        );
    }

    let sorted = sort_entries(entries);
    let input = format_repo_rows(&sorted);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--no-tac",
            "--delimiter",
            "\t",
            "--with-nth",
            "1,2,3",
            "--header-lines",
            "1",
            "--prompt",
            "repo> ",
        ],
    )?;

    let path_str = parse_repo_selection(&selected)?;
    Ok(PathBuf::from(path_str))
}

pub fn discover_repos(roots: &[PathBuf]) -> anyhow::Result<Vec<RepoEntry>> {
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

/// 指定ディレクトリが属する git リポジトリのメインリポジトリパスを検出する。
///
/// `git rev-parse --path-format=absolute --git-common-dir` の親ディレクトリを
/// メインリポジトリパスとして解決する。worktree の場合は git-common-dir が
/// メインリポジトリの `.git` ディレクトリを指すため、通常リポジトリと同一の
/// ロジックでメインリポジトリに解決される。
/// git リポジトリ外の場合や検出に失敗した場合は `None` を返す。
pub fn detect_current_repo_path(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(cwd)
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let common_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
    common_dir.parent().map(|p| p.to_path_buf())
}

/// 検出されたリポジトリパスと一致する列挙内エントリのインデックスを返す。
///
/// シンボリックリンクや表記揺れを吸収するため、正規化（canonicalize）したパスで
/// 比較する。正規化に失敗した場合は生のパスで比較する。一致するエントリがなければ
/// `None` を返す。
pub fn find_matching_entry_index(entries: &[RepoEntry], repo_path: &Path) -> Option<usize> {
    let target = normalize_for_compare(repo_path);
    entries
        .iter()
        .position(|e| normalize_for_compare(&e.path) == target)
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn sort_entries(entries: Vec<RepoEntry>) -> Vec<RepoEntry> {
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
            .then_with(|| a.name.cmp(&b.name))
    });
    sorted
}

pub fn format_repo_rows(entries: &[RepoEntry]) -> String {
    let mut lines = vec![format_repo_header(entries)];
    for entry in entries {
        let path = entry.path.display().to_string();
        let padded = format_padded_row(&entry.category, &entry.name, &entry.label(), entries);
        lines.push(format!("{padded}\t{path}"));
    }
    lines.join("\n") + "\n"
}

pub fn parse_repo_selection(selected: &str) -> anyhow::Result<String> {
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

pub fn run_fzf(input: String, args: &[&str]) -> anyhow::Result<String> {
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

fn inspect_repo_dir(path: &Path, category: &str) -> Option<RepoEntry> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())?;

    let git_path = path.join(".git");
    if !git_path.is_dir() {
        return None;
    }

    let head_info = read_head_info(&git_path);

    Some(RepoEntry {
        category: category.to_string(),
        name,
        path: path.to_path_buf(),
        head_info,
    })
}

fn read_head_info(git_path: &Path) -> HeadInfo {
    let head_path = git_path.join("HEAD");

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

fn format_repo_header(entries: &[RepoEntry]) -> String {
    format_padded_row("category", "name", "branch", entries)
}

fn format_padded_row(category: &str, name: &str, branch: &str, entries: &[RepoEntry]) -> String {
    let widths = column_widths(entries);
    format!(
        "{:<w_cat$}  {:<w_name$}  {:<w_br$}",
        category,
        name,
        branch,
        w_cat = widths.0,
        w_name = widths.1,
        w_br = widths.2
    )
}

fn column_widths(entries: &[RepoEntry]) -> (usize, usize, usize) {
    let mut w_category = "category".chars().count();
    let mut w_name = "name".chars().count();
    let mut w_branch = "branch".chars().count();

    for entry in entries {
        w_category = w_category.max(entry.category.chars().count());
        w_name = w_name.max(entry.name.chars().count());
        w_branch = w_branch.max(entry.label().chars().count());
    }

    (w_category, w_name, w_branch)
}
