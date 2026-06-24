use std::path::PathBuf;

use anyhow::Context;

use dialoguer::Select;

use crate::cli::style;
use crate::git::common::{
    command_output, command_output_in, current_branch, ensure_inside_git_repo,
    generate_commit_message, is_protected_branch, resolve_target_branch, snapshot_git_state,
    worktree_has_uncommitted_changes,
};
use crate::git::worktree::find_worktree_for_branch;

pub fn ship(
    target: Option<String>,
    target_default: bool,
    message: Option<String>,
) -> anyhow::Result<()> {
    ensure_inside_git_repo()?;
    style::intro("mt git ship");

    let current = current_branch()?;
    if is_protected_branch(&current) {
        anyhow::bail!(
            "デフォルトブランチ ( {current} ) では ship を実行できません。feature branch などで実行してください"
        );
    }

    let target_branch = resolve_target_branch(target.clone(), target_default)?;
    if target_branch == current {
        anyhow::bail!(
            "target ({target_branch}) が現在のブランチと同じです。別のブランチを指定してください"
        );
    }
    style::info(&format!("feature: {current}"));
    style::info(&format!("target : {target_branch}"));

    let current_cwd = std::env::current_dir()?;
    let target_worktree = find_worktree_for_branch(&target_branch);
    let has_conflict = target_worktree
        .as_ref()
        .map(|p| p != &current_cwd)
        .unwrap_or(false);

    if has_conflict {
        let target_wt = target_worktree.as_ref().expect("has_conflict implies Some");
        if worktree_has_uncommitted_changes(target_wt) {
            style::error(&format!(
                "対象ブランチ {target_branch} を保持する worktree ({}) に未コミットの変更があります。\n手動で commit / stash / 破棄を行ってから再実行してください。",
                target_wt.display()
            ));
            anyhow::bail!("dirty worktree のため中断");
        }
        style::warn(&format!(
            "対象ブランチ {target_branch} は別 worktree ({}) でチェックアウトされています。\nその worktree 内で pull / merge / push を実行します。",
            target_wt.display()
        ));
    }

    let target_cwd: PathBuf = if has_conflict {
        target_worktree.expect("has_conflict implies Some")
    } else {
        current_cwd.clone()
    };

    style::info(&format!("ステップ 1/5: {target_branch} を最新化"));
    if has_conflict {
        style::info(&format!(
            "checkout 不要 ({} で既に checkout 済み)",
            target_cwd.display()
        ));
    } else if !checkout_branch(&target_branch, &current)? {
        return Ok(());
    }
    let spinner = style::spinner(&format!("git pull --ff-only origin {target_branch}"));
    if let Err(e) = command_output_in(
        &target_cwd,
        "git",
        &["pull", "--ff-only", "origin", &target_branch],
    ) {
        spinner.finish_with_message("pull 失敗");
        handle_failure(
            "pull target",
            &format!("{e} (origin/{target_branch} への pull に失敗)"),
            &current,
        )?;
        return Ok(());
    }
    spinner.finish_with_message("pull 完了");

    style::info(&format!("ステップ 2/5: feature ({current}) に戻る"));
    if has_conflict {
        style::info(&format!(
            "feature は {} にいるので checkout 不要",
            current_cwd.display()
        ));
    } else if !checkout_branch(&current, &current)? {
        return Ok(());
    }

    style::info("ステップ 3/5: 変更をステージングしてコミット");
    let added = add_changed_files_in(&current_cwd)?;
    let commit_message = match &message {
        Some(m) if !m.is_empty() => m.clone(),
        _ => {
            let stat = command_output_in(&current_cwd, "git", &["diff", "--staged", "--shortstat"])
                .unwrap_or_default();
            generate_commit_message(&stat)
        }
    };
    if added.is_empty() {
        style::info("コミット対象の変更がありません（既にコミット済みの可能性）");
    } else {
        style::info(&format!("{} ファイルを add", added.len()));
        style::info(&format!("commit: {commit_message}"));
        let spinner = style::spinner("git commit");
        if let Err(e) = command_output_in(&current_cwd, "git", &["commit", "-m", &commit_message]) {
            spinner.finish_with_message("commit 失敗");
            handle_failure("commit", &e.to_string(), &current)?;
            return Ok(());
        }
        spinner.finish_with_message("commit 完了");
    }

    style::info("ステップ 4/5: feature を push");
    let spinner = style::spinner("git push -u origin HEAD");
    if let Err(e) = command_output_in(&current_cwd, "git", &["push", "-u", "origin", "HEAD"]) {
        spinner.finish_with_message("push 失敗");
        handle_failure("push feature", &e.to_string(), &current)?;
        return Ok(());
    }
    spinner.finish_with_message("push 完了");

    style::info(&format!(
        "ステップ 5/5: {target_branch} に --no-ff マージして push"
    ));
    if !has_conflict && !checkout_branch(&target_branch, &current)? {
        return Ok(());
    }
    let spinner = style::spinner(&format!("git merge --no-ff {current}"));
    let merge_result = if message.as_ref().is_some_and(|m| !m.is_empty()) {
        command_output_in(
            &target_cwd,
            "git",
            &["merge", "--no-ff", "-m", &commit_message, &current],
        )
    } else {
        command_output_in(&target_cwd, "git", &["merge", "--no-ff", &current])
    };
    if let Err(e) = merge_result {
        spinner.finish_with_message("merge 失敗");
        handle_failure(
            "merge --no-ff",
            &format!("{e} ({current} → {target_branch} のマージに失敗)"),
            &current,
        )?;
        return Ok(());
    }
    spinner.finish_with_message("merge 完了");

    let spinner = style::spinner(&format!("git push origin {target_branch}"));
    if let Err(e) = command_output_in(&target_cwd, "git", &["push", "origin", &target_branch]) {
        spinner.finish_with_message("push 失敗");
        handle_failure(
            "push target",
            &format!("{e} (origin/{target_branch} への push に失敗)"),
            &current,
        )?;
        return Ok(());
    }
    spinner.finish_with_message("push 完了");

    if !has_conflict {
        let _ = restore_original_branch(&current);
    }

    style::outro(&format!(
        "✅ ship 完了: {current} → {target_branch} にマージ済み、リモートに push 済み"
    ));
    Ok(())
}

fn restore_original_branch(target: &str) -> anyhow::Result<()> {
    let spinner = style::spinner(&format!("git checkout {target}"));
    match command_output("git", &["checkout", target]) {
        Ok(_) => {
            spinner.finish_with_message(format!("checkout {target} 完了"));
            Ok(())
        }
        Err(e) => {
            spinner.finish_with_message("checkout 失敗");
            style::warn(&format!(
                "{target} への checkout に失敗しました: {e}\n手動で git checkout {target} を実行してください"
            ));
            Ok(())
        }
    }
}

fn checkout_branch(target: &str, original: &str) -> anyhow::Result<bool> {
    let spinner = style::spinner(&format!("git checkout {target}"));
    if let Err(e) = command_output("git", &["checkout", target]) {
        spinner.finish_with_message("checkout 失敗");
        handle_failure(
            "checkout",
            &format!("{e} (git checkout {target} に失敗)"),
            original,
        )?;
        return Ok(false);
    }
    spinner.finish_with_message(format!("checkout {target} 完了"));
    Ok(true)
}

fn add_changed_files_in(cwd: &std::path::Path) -> anyhow::Result<Vec<String>> {
    let status = command_output_in(cwd, "git", &["status", "--porcelain"])?;
    let mut added = Vec::new();
    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }
        let path = &line[3..];
        let actual_path = if let Some(idx) = path.find(" -> ") {
            &path[idx + 4..]
        } else {
            path
        };
        command_output_in(cwd, "git", &["add", "--", actual_path])
            .with_context(|| format!("git add {actual_path} に失敗"))?;
        added.push(actual_path.to_string());
    }
    Ok(added)
}

fn handle_failure(step: &str, detail: &str, current_branch: &str) -> anyhow::Result<()> {
    style::error(&format!("[{step}] {detail}"));
    style::info("現在の git 状態:");
    println!("{}", snapshot_git_state());

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
