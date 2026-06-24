use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use console::Style;
use dialoguer::Confirm;
use regex::Regex;

use crate::cli::style;

struct WorktreeEntry {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
    shortstat: String,
}

impl WorktreeEntry {
    fn name(&self) -> String {
        Path::new(&self.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&self.path)
            .to_string()
    }

    fn label(&self) -> String {
        if self.is_bare {
            "(bare)".to_string()
        } else if self.is_detached {
            let short_head = self
                .head
                .as_deref()
                .map(|head| head.chars().take(7).collect::<String>())
                .filter(|head| !head.is_empty())
                .unwrap_or_else(|| "detached".to_string());
            format!("({short_head})")
        } else {
            format!("[{}]", self.branch.as_deref().unwrap_or("?"))
        }
    }
}

#[derive(Default)]
struct WorktreeBuilder {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
}

impl WorktreeBuilder {
    fn push_if_ready(&mut self, entries: &mut Vec<WorktreeEntry>) {
        if let Some(path) = self.path.take() {
            entries.push(WorktreeEntry {
                path,
                head: self.head.take(),
                branch: self.branch.take(),
                is_bare: self.is_bare,
                is_detached: self.is_detached,
                shortstat: String::new(),
            });
        }

        self.is_bare = false;
        self.is_detached = false;
    }
}

pub fn select() -> anyhow::Result<()> {
    ensure_inside_git_repo()?;
    ensure_fzf()?;

    let current = command_output("git", &["rev-parse", "--show-toplevel"])
        .context("現在の Git リポジトリルートを取得できませんでした")?;
    let porcelain = command_output("git", &["worktree", "list", "--porcelain"])
        .context("git worktree の一覧を取得できませんでした")?;
    let mut entries = parse_worktree_porcelain(&porcelain);
    collect_shortstat(&mut entries);

    if entries.is_empty() {
        anyhow::bail!("git worktree が見つかりませんでした");
    }

    let input = "● current worktree\n".to_string() + &format_worktree_rows(&entries, &current);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--delimiter",
            "\t",
            "--with-nth",
            "1",
            "--header-lines",
            "1",
            "--prompt",
            "worktree> ",
        ],
    )?;

    let Some(target) = selected.trim_end().rsplit('\t').next() else {
        anyhow::bail!("worktree の選択結果を解析できませんでした");
    };

    if target.is_empty() || target == selected.trim_end() {
        anyhow::bail!("worktree の選択結果を解析できませんでした");
    }

    println!("{target}");
    Ok(())
}

fn ensure_inside_git_repo() -> anyhow::Result<()> {
    let status = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("git の実行に失敗しました")?;

    if !status.success() {
        anyhow::bail!("Not inside a git repository.");
    }

    Ok(())
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

fn command_output(command: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .with_context(|| format!("{command} の実行に失敗しました"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{command} が失敗しました: {}", stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current = WorktreeBuilder::default();

    for line in output.lines() {
        if line.is_empty() {
            current.push_if_ready(&mut entries);
        } else if let Some(path) = line.strip_prefix("worktree ") {
            current.push_if_ready(&mut entries);
            current.path = Some(path.to_string());
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        } else if line == "bare" {
            current.is_bare = true;
        } else if line == "detached" {
            current.is_detached = true;
        }
    }

    current.push_if_ready(&mut entries);
    entries
}

pub fn find_worktree_for_branch(branch: &str) -> Option<PathBuf> {
    let output = command_output("git", &["worktree", "list", "--porcelain"]).ok()?;
    for entry in parse_worktree_porcelain(&output) {
        if entry.branch.as_deref() == Some(branch) {
            return Some(PathBuf::from(entry.path));
        }
    }
    None
}

fn collect_shortstat(entries: &mut [WorktreeEntry]) {
    for entry in entries.iter_mut() {
        if entry.is_bare {
            continue;
        }
        let output = Command::new("git")
            .args(["-C", &entry.path, "diff", "--shortstat"])
            .output();
        if let Ok(out) = output
            && out.status.success()
        {
            entry.shortstat = parse_shortstat(&String::from_utf8_lossy(&out.stdout));
        }
    }
}

fn parse_shortstat(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let insertions = parse_shortstat_count(trimmed, r"(\d+) insertions?\(\+\)");
    let deletions = parse_shortstat_count(trimmed, r"(\d+) deletions?\(-\)");
    if insertions == 0 && deletions == 0 {
        return String::new();
    }
    format!("+{insertions} -{deletions}")
}

fn parse_shortstat_count(s: &str, pattern: &str) -> u32 {
    Regex::new(pattern)
        .ok()
        .and_then(|re| re.captures(s))
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .unwrap_or(0)
}

fn format_worktree_rows(entries: &[WorktreeEntry], current: &str) -> String {
    let max_name_width = entries
        .iter()
        .map(|entry| entry.name().chars().count())
        .max()
        .unwrap_or(0);
    let max_label_width = entries
        .iter()
        .map(|entry| entry.label().chars().count())
        .max()
        .unwrap_or(0);
    let max_stat_width = entries
        .iter()
        .map(|entry| entry.shortstat.chars().count())
        .max()
        .unwrap_or(0);
    let current_dot = Style::new().green().bold().apply_to("●").to_string();
    let plus_style = Style::new().green();
    let minus_style = Style::new().red();

    entries
        .iter()
        .map(|entry| {
            let marker = if entry.path == current {
                format!("{current_dot} ")
            } else {
                "  ".to_string()
            };
            let stat = format_shortstat_colored(
                &entry.shortstat,
                max_stat_width,
                &plus_style,
                &minus_style,
            );
            format!(
                "{marker}{:<name_width$}  {:<label_width$}  {stat}\t{}",
                entry.name(),
                entry.label(),
                entry.path,
                name_width = max_name_width,
                label_width = max_label_width,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn format_shortstat_colored(
    stat: &str,
    width: usize,
    plus_style: &Style,
    minus_style: &Style,
) -> String {
    if stat.is_empty() {
        return " ".repeat(width);
    }
    let visible_width = stat.chars().count();
    let padding = " ".repeat(width.saturating_sub(visible_width));
    if let Some((plus, rest)) = stat.split_once(' ') {
        let plus_colored = plus_style.apply_to(plus).to_string();
        let minus_colored = minus_style.apply_to(rest).to_string();
        format!("{plus_colored} {minus_colored}{padding}")
    } else {
        let plus_colored = plus_style.apply_to(stat).to_string();
        format!("{plus_colored}{padding}")
    }
}

fn run_fzf(input: String, args: &[&str]) -> anyhow::Result<String> {
    let mut child = Command::new("fzf")
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

pub fn create() -> anyhow::Result<()> {
    ensure_inside_git_repo()?;
    style::intro("Git worktree 作成");

    let main_repo = resolve_main_repo_path()?;
    let parent_dir = main_repo
        .parent()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "main repo の親ディレクトリが取得できません: {}",
                main_repo.display()
            )
        })?
        .to_path_buf();
    let main_name = main_repo
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("main repo 名が取得できません: {}", main_repo.display()))?
        .to_string();

    let porcelain = command_output("git", &["worktree", "list", "--porcelain"])?;
    let entries = parse_worktree_porcelain(&porcelain);

    let next_index = next_worktree_index(&entries, &parent_dir, &main_name);
    let new_name = format!("{main_name}-wt-{next_index}");
    let new_path = parent_dir.join(&new_name);

    if new_path.exists() {
        style::error(&format!(
            "ターゲットパスが既に存在します: {}",
            new_path.display()
        ));
        style::outro("中止しました");
        return Ok(());
    }

    let base = resolve_base_branch().unwrap_or_else(|_| "HEAD".to_string());
    let current_repo = command_output("git", &["rev-parse", "--show-toplevel"])?;
    let attach_to_existing = branch_exists(Path::new(&current_repo), &new_name);

    style::info(&format!("worktree パス: {}", new_path.display()));
    if attach_to_existing {
        style::info(&format!(
            "branch       : {new_name} (既存 branch に attach)"
        ));
    } else {
        style::info(&format!("新規 branch  : {new_name}"));
        style::info(&format!("派生元       : {base}"));
    }

    let confirm = Confirm::new()
        .with_prompt("この内容で作成しますか？")
        .default(true)
        .interact()?;

    if !confirm {
        style::outro("中止しました");
        return Ok(());
    }

    let spinner = style::spinner("worktree を作成中...");
    let result = if attach_to_existing {
        Command::new("git")
            .args(["worktree", "add"])
            .arg(&new_path)
            .arg(&new_name)
            .status()
    } else {
        Command::new("git")
            .args(["worktree", "add", "-b", &new_name])
            .arg(&new_path)
            .arg(&base)
            .status()
    };
    match result {
        Ok(status) if status.success() => {
            spinner.finish_with_message("worktree を作成しました");
            style::outro(&format!("✅ {}", new_path.display()));
        }
        Ok(_) => {
            spinner.finish_with_message("worktree の作成に失敗しました");
            style::error("git worktree add が失敗しました");
            style::outro("中止しました");
        }
        Err(e) => {
            spinner.finish_with_message("worktree の作成に失敗しました");
            return Err(e).context("git worktree add の起動に失敗しました");
        }
    }

    Ok(())
}

pub fn delete(force: bool) -> anyhow::Result<()> {
    ensure_inside_git_repo()?;
    ensure_fzf()?;

    let current = command_output("git", &["rev-parse", "--show-toplevel"])?;
    let porcelain = command_output("git", &["worktree", "list", "--porcelain"])?;
    let mut entries = parse_worktree_porcelain(&porcelain);
    collect_shortstat(&mut entries);

    if entries.is_empty() {
        bail!("git worktree が見つかりませんでした");
    }

    style::intro("Git worktree 削除");

    let input = "● current worktree\n".to_string() + &format_worktree_rows(&entries, &current);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--delimiter",
            "\t",
            "--with-nth",
            "1",
            "--header-lines",
            "1",
            "--prompt",
            "delete> ",
        ],
    )?;

    let Some(target) = selected.trim_end().rsplit('\t').next() else {
        bail!("worktree の選択結果を解析できませんでした");
    };

    if target.is_empty() || target == selected.trim_end() {
        bail!("worktree の選択結果を解析できませんでした");
    }

    let target_path = PathBuf::from(target);
    let is_current = target == current;

    if is_current {
        style::warn("現在の作業ディレクトリの worktree を削除します");
    }

    if !force {
        let issues = check_worktree_safety(&target_path)?;
        for issue in &issues {
            let proceed = Confirm::new()
                .with_prompt(format!("{} - 続行しますか？", issue.message()))
                .default(false)
                .interact()?;
            if !proceed {
                style::outro("中止しました");
                return Ok(());
            }
        }

        let final_confirm = Confirm::new()
            .with_prompt(format!("worktree を削除します: {target}\nよろしいですか？"))
            .default(false)
            .interact()?;

        if !final_confirm {
            style::outro("中止しました");
            return Ok(());
        }
    }

    if is_current && let Some(parent) = target_path.parent() {
        std::env::set_current_dir(parent).with_context(|| {
            format!(
                "現在のディレクトリの変更に失敗しました: {}",
                parent.display()
            )
        })?;
    }

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(target);

    let spinner = style::spinner("worktree を削除中...");
    let result = Command::new("git").args(&args).status();
    match result {
        Ok(status) if status.success() => {
            spinner.finish_with_message("worktree を削除しました");
            println!();
            style::info(&format_recovery_hints(&target_path));
            style::outro("✅ 削除完了");
        }
        Ok(_) => {
            spinner.finish_with_message("worktree の削除に失敗しました");
            style::error("git worktree remove が失敗しました");
            style::outro("中止しました");
        }
        Err(e) => {
            spinner.finish_with_message("worktree の削除に失敗しました");
            return Err(e).context("git worktree remove の起動に失敗しました");
        }
    }

    Ok(())
}

fn resolve_main_repo_path() -> anyhow::Result<PathBuf> {
    let common_dir = command_output(
        "git",
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = PathBuf::from(common_dir);
    let main = common
        .parent()
        .ok_or_else(|| {
            anyhow::anyhow!("git common dir の親が取得できません: {}", common.display())
        })?
        .to_path_buf();
    Ok(main)
}

fn next_worktree_index(entries: &[WorktreeEntry], parent_dir: &Path, repo_name: &str) -> usize {
    let prefix = format!("{repo_name}-wt-");
    entries
        .iter()
        .filter_map(|entry| {
            let path = Path::new(&entry.path);
            let parent = path.parent()?;
            if parent != parent_dir {
                return None;
            }
            let name = path.file_name()?.to_str()?;
            let suffix = name.strip_prefix(&prefix)?;
            suffix.parse::<usize>().ok()
        })
        .max()
        .map(|n| n + 1)
        .unwrap_or(1)
}

fn resolve_base_branch() -> anyhow::Result<String> {
    if let Ok(target) = command_output("git", &["symbolic-ref", "refs/remotes/origin/HEAD"])
        && let Some(short) = target.strip_prefix("refs/heads/")
    {
        return Ok(short.to_string());
    }
    if command_status("git", &["rev-parse", "--verify", "--quiet", "main"]) {
        return Ok("main".to_string());
    }
    if command_status("git", &["rev-parse", "--verify", "--quiet", "master"]) {
        return Ok("master".to_string());
    }
    bail!(
        "派生元の branch を特定できませんでした (origin/HEAD, main, master のいずれも見つかりません)"
    )
}

fn command_status(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn branch_exists(repo_path: &Path, branch: &str) -> bool {
    let Some(repo_str) = repo_path.to_str() else {
        return false;
    };
    command_status(
        "git",
        &[
            "-C",
            repo_str,
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
}

#[derive(Debug)]
struct SafetyIssue {
    kind: SafetyKind,
    detail: String,
}

#[derive(Debug)]
enum SafetyKind {
    Uncommitted,
    Unpushed,
    Unmerged,
}

impl SafetyIssue {
    fn message(&self) -> String {
        match self.kind {
            SafetyKind::Uncommitted => format!("未コミットの変更があります ({})", self.detail),
            SafetyKind::Unpushed => format!("未 push の commit があります ({})", self.detail),
            SafetyKind::Unmerged => format!("未マージの branch です ({})", self.detail),
        }
    }
}

fn check_worktree_safety(path: &Path) -> anyhow::Result<Vec<SafetyIssue>> {
    let mut issues = Vec::new();
    let Some(path_str) = path.to_str() else {
        return Ok(issues);
    };

    if let Ok(out) = command_output("git", &["-C", path_str, "status", "--porcelain"])
        && !out.is_empty()
    {
        let count = out.lines().count();
        issues.push(SafetyIssue {
            kind: SafetyKind::Uncommitted,
            detail: format!("{count} ファイル"),
        });
    }

    if let Ok(upstream) = command_output(
        "git",
        &[
            "-C",
            path_str,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
    ) {
        let upstream = upstream.trim().to_string();
        if !upstream.is_empty() {
            let range = format!("{upstream}..HEAD");
            if let Ok(commits) =
                command_output("git", &["-C", path_str, "log", "--oneline", &range])
                && !commits.is_empty()
            {
                let count = commits.lines().count();
                issues.push(SafetyIssue {
                    kind: SafetyKind::Unpushed,
                    detail: format!("{count} commits ({upstream})"),
                });
            }
        }
    }

    if let Ok(branch) = command_output(
        "git",
        &["-C", path_str, "rev-parse", "--abbrev-ref", "HEAD"],
    ) {
        let branch = branch.trim();
        if !branch.is_empty() && branch != "HEAD" {
            for base in ["main", "master"] {
                if branch == base {
                    continue;
                }
                if command_status(
                    "git",
                    &["-C", path_str, "rev-parse", "--verify", "--quiet", base],
                ) {
                    let merged = Command::new("git")
                        .args(["-C", path_str, "merge-base", "--is-ancestor", branch, base])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    if !merged {
                        issues.push(SafetyIssue {
                            kind: SafetyKind::Unmerged,
                            detail: format!("{branch} が {base} に未マージ"),
                        });
                    }
                    break;
                }
            }
        }
    }

    Ok(issues)
}

fn format_recovery_hints(deleted_path: &Path) -> String {
    let name = deleted_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("worktree");
    format!(
        "復旧ヒント:\n\
         - worktree 登録の掃除: git worktree prune\n\
         - 削除した branch の復元: git reflog | grep '{name}' で commit を確認し、git branch <name> <sha> で復元\n\
         - detached HEAD だった場合: git checkout <sha> で参照可能"
    )
}

#[cfg(test)]
#[path = "worktree.test.rs"]
mod tests;
