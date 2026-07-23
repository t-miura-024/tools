use anyhow::{Context, bail};
use console::Style;

use crate::git::common;

use super::entry::{self, WorktreeEntry};

pub(super) struct PickedWorktree {
    pub(super) target: String,
    pub(super) is_current: bool,
}

/// worktree 一覧を fzf で選択させ、選ばれた worktree パスを返す。
/// select / delete が共有していた「一覧取得 → shortstat 収集 → fzf → 結果解析」
/// のフローを 1 箇所に集約する。
pub(super) fn pick_worktree(prompt: &str) -> anyhow::Result<PickedWorktree> {
    let current = common::command_output("git", &["rev-parse", "--show-toplevel"])
        .context("現在の Git リポジトリルートを取得できませんでした")?;
    let porcelain = common::command_output("git", &["worktree", "list", "--porcelain"])
        .context("git worktree の一覧を取得できませんでした")?;
    let mut entries = entry::parse_worktree_porcelain(&porcelain);
    entry::collect_shortstat(&mut entries);

    if entries.is_empty() {
        bail!("git worktree が見つかりませんでした");
    }

    let input = "● current worktree\n".to_string() + &format_worktree_rows(&entries, &current);
    let selected = common::run_fzf(
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
            prompt,
        ],
    )?;

    let Some(target) = selected.trim_end().rsplit('\t').next() else {
        bail!("worktree の選択結果を解析できませんでした");
    };

    if target.is_empty() || target == selected.trim_end() {
        bail!("worktree の選択結果を解析できませんでした");
    }

    Ok(PickedWorktree {
        is_current: target == current,
        target: target.to_string(),
    })
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
    let current_dot = Style::new()
        .green()
        .bold()
        .force_styling(true)
        .apply_to("●")
        .to_string();
    let plus_style = Style::new().green().force_styling(true);
    let minus_style = Style::new().red().force_styling(true);

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

#[cfg(test)]
#[path = "pick.test.rs"]
mod tests;
