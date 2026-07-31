//! `mt difit check` — ゲート判定。
//!
//! 完了条件 2: 未解決スレッド親の taxonomy で exit コードを決定。
//! 完了条件 5: stale 状態（サーバ死）を自己修復。

use super::shared;

/// `mt difit check` のエントリポイント。
///
/// ゲート通過 → `Ok(())`（exit 0）、ブロック → `std::process::exit(1)`。
pub fn check() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;

    let state = match shared::read_review_state(&repo_root) {
        Some(s) => s,
        None => {
            anyhow::bail!(
                "アクティブな difit レビューセッションがありません。先に mt difit start を実行してください"
            );
        }
    };

    // --- stale 自己修復（完了条件 5）---
    let port = if shared::is_process_alive(state.pid) {
        state.port
    } else {
        // サーバ死 → 保存済みコメントで再起動
        let bg = shared::spawn_difit_server(&repo_root, &state.difit_args, &state.comments)?;

        let new_state = shared::ReviewState {
            port: bg.port,
            pid: bg.pid,
            comments: state.comments,
            difit_args: state.difit_args,
        };
        shared::write_review_state(&repo_root, &new_state)?;
        bg.port
    };

    // --- コメント取得 & ゲート判定 ---
    let response = shared::fetch_comments(port)?;
    let passes = shared::gate_passes(&response.threads);

    if passes {
        // ゲート通過 → サーバ終了 & 状態削除
        shared::kill_server(
            shared::read_review_state(&repo_root)
                .map(|s| s.pid)
                .unwrap_or(state.pid),
        );
        shared::delete_review_state(&repo_root);
        Ok(())
    } else {
        // ゲートブロック → exit 1
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "check.test.rs"]
mod tests;
