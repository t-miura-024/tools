//! `mt difit check` — ゲート判定。
//!
//! 完了条件 2: 未解決スレッド親の taxonomy で exit コードを決定。
//! 完了条件 5: stale 状態（サーバ死）を自己修復。

use serde::Serialize;

use super::shared::{self, Taxonomy, Thread};

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
    let (port, current_pid) = if shared::is_process_alive(state.pid) {
        (state.port, state.pid)
    } else {
        let bg = shared::spawn_difit_server(&repo_root, &state.difit_args, &state.comments)?;

        let new_state = shared::ReviewState {
            port: bg.port,
            pid: bg.pid,
            comments: state.comments,
            difit_args: state.difit_args,
        };
        shared::write_review_state(&repo_root, &new_state)?;
        (bg.port, bg.pid)
    };

    // --- コメント取得 & ゲート判定 ---
    let response = shared::fetch_comments(port)?;

    if shared::gate_passes(&response.threads) {
        shared::kill_server(current_pid);
        shared::delete_review_state(&repo_root);
        let out = CheckOutput {
            passes: true,
            blocking_threads: Vec::new(),
        };
        println!("{}", serde_json::to_string(&out)?);
        Ok(())
    } else {
        let blocking_threads = response
            .threads
            .iter()
            .filter_map(|t| BlockingThread::from_thread(t))
            .collect();
        let out = CheckOutput {
            passes: false,
            blocking_threads,
        };
        println!("{}", serde_json::to_string(&out)?);
        std::process::exit(1);
    }
}

#[derive(Serialize)]
struct CheckOutput {
    passes: bool,
    blocking_threads: Vec<BlockingThread>,
}

#[derive(Serialize)]
struct BlockingThread {
    id: String,
    file: String,
    line: Option<serde_json::Value>,
    taxonomy: String,
    body: String,
    replies: Vec<String>,
}

impl BlockingThread {
    fn from_thread(thread: &Thread) -> Option<Self> {
        let parent = thread.messages.first()?;
        let taxonomy = shared::classify_body(&parent.body);
        if !shared::is_blocking(taxonomy) {
            return None;
        }
        Some(Self {
            id: thread.id.clone(),
            file: thread.file_path.clone(),
            line: thread.position.get("line").cloned(),
            taxonomy: taxonomy_label(taxonomy),
            body: parent.body.clone(),
            replies: thread.messages[1..].iter().map(|m| m.body.clone()).collect(),
        })
    }
}

fn taxonomy_label(t: Taxonomy) -> String {
    match t {
        Taxonomy::Issue => "issue",
        Taxonomy::Question => "question",
        Taxonomy::Context => "context",
        Taxonomy::Human => "human",
    }
    .to_string()
}

#[cfg(test)]
#[path = "check.test.rs"]
mod tests;
