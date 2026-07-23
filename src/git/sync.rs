use std::path::Path;

use dialoguer::Select;

use crate::cli::style;
use crate::git::common::{
    command_output_in, current_branch_in, ensure_inside_git_repo_in, is_protected_branch,
    resolve_target_branch_in, snapshot_git_state_in,
};

pub fn sync(target: Option<String>, target_default: bool) -> anyhow::Result<()> {
    sync_in(&std::env::current_dir()?, target, target_default)
}

pub fn sync_in(cwd: &Path, target: Option<String>, target_default: bool) -> anyhow::Result<()> {
    ensure_inside_git_repo_in(cwd)?;
    style::intro("mt git sync");

    let current = current_branch_in(cwd)?;
    if is_protected_branch(&current) {
        anyhow::bail!(
            "デフォルトブランチ ( {current} ) では sync を実行できません。feature branch などで実行してください"
        );
    }

    style::info(&format!("現在のブランチ: {current}"));

    let target_branch = resolve_target_branch_in(cwd, target.clone(), target_default)?;
    if target_branch == current {
        anyhow::bail!(
            "target ({target_branch}) が現在のブランチと同じです。別のブランチを指定してください"
        );
    }

    style::info("ステップ 1/2: 現在のブランチを upstream と同期します");
    let spinner = style::spinner("git fetch origin ...");
    if let Err(e) = command_output_in(cwd, "git", &["fetch", "origin"]) {
        spinner.finish_with_message("fetch 失敗");
        handle_failure_in(cwd, "fetch", &e.to_string(), &current)?;
        return Ok(());
    }
    spinner.finish_with_message("fetch 完了");

    let spinner = style::spinner(&format!("git merge --ff-only origin/{current} ..."));
    let upstream = format!("origin/{current}");
    if let Err(e) = command_output_in(cwd, "git", &["merge", "--ff-only", &upstream]) {
        spinner.finish_with_message("ff-only merge 失敗");
        handle_failure_in(
            cwd,
            "ff-only merge",
            &format!("{e} ({upstream} への fast-forward merge に失敗)"),
            &current,
        )?;
        return Ok(());
    }
    spinner.finish_with_message("ff-only merge 完了");

    style::info("ステップ 2/2: target branch の変更を現在のブランチに取り込みます");
    style::info(&format!("target: {target_branch}"));
    let spinner = style::spinner(&format!("git pull --no-rebase origin {target_branch} ..."));
    if let Err(e) = command_output_in(cwd, "git", &["pull", "--no-rebase", "origin", &target_branch])
    {
        spinner.finish_with_message("pull 失敗");
        handle_failure_in(
            cwd,
            "pull target",
            &format!("{e} (origin/{target_branch} の pull に失敗)"),
            &current,
        )?;
        return Ok(());
    }
    spinner.finish_with_message("pull 完了");

    style::outro(&format!(
        "✅ sync 完了: {current} は最新の {target_branch} を取り込み済み"
    ));
    Ok(())
}

fn handle_failure_in(
    cwd: &Path,
    step: &str,
    detail: &str,
    current_branch: &str,
) -> anyhow::Result<()> {
    style::error(&format!("[{step}] {detail}"));
    style::info("現在の git 状態:");
    println!("{}", snapshot_git_state_in(cwd));

    let options = vec![
        "abort - 現状を維持して中断",
        "rebase 手順を表示 - git pull --rebase の手順を出力",
        "force 手順を表示 - --force-with-lease の手順を出力（非推奨）",
    ];

    let selection = match Select::new()
        .with_prompt("次のアクションを選択")
        .items(&options)
        .default(0)
        .interact()
    {
        Ok(sel) => sel,
        Err(_) => {
            style::warn("対話入力ができないため、abort を選択しました");
            style::outro("abort しました。手動で git status / git reflog を確認してください");
            anyhow::bail!("ユーザー中断");
        }
    };

    match selection {
        0 => {
            style::outro("abort しました。手動で git status / git reflog を確認してください");
        }
        1 => {
            style::info(&format!(
                "推奨手順:\n  git pull --rebase origin {current_branch}\n  競合した場合:\n    git status\n    修正後に git add <file>\n    git rebase --continue\n    取り消す場合: git rebase --abort"
            ));
            style::outro("rebase 手順を表示しました");
        }
        2 => {
            style::warn(
                "force 操作は履歴を書き換えるため推奨しません。実施する場合は以下:\n  git push --force-with-lease origin <branch>",
            );
            style::outro("force 手順を表示しました");
        }
        _ => unreachable!(),
    }

    Ok(())
}

#[cfg(test)]
#[path = "sync.test.rs"]
mod tests;
