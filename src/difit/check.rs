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
    let out = output_for_response(&response);

    if out.passes {
        shared::kill_server(current_pid);
        shared::delete_review_state(&repo_root);
        println!("{}", serde_json::to_string(&out)?);
        Ok(())
    } else {
        println!("{}", serde_json::to_string(&out)?);
        std::process::exit(1);
    }
}

#[derive(Serialize)]
pub(crate) struct CheckOutput {
    passes: bool,
    blocking_threads: Vec<BlockingThread>,
}

/// コメント取得結果から、`check` / `done` 共通のゲート出力を作る。
pub(crate) fn output_for_response(response: &shared::CommentGetResponse) -> CheckOutput {
    let passes = shared::gate_passes(&response.threads);
    let blocking_threads = if passes {
        Vec::new()
    } else {
        response
            .threads
            .iter()
            .filter_map(|t| BlockingThread::from_thread(t))
            .collect()
    };

    CheckOutput {
        passes,
        blocking_threads,
    }
}

/// レビュー状態がない場合の冪等な終了結果。
pub(crate) fn empty_output() -> CheckOutput {
    CheckOutput {
        passes: true,
        blocking_threads: Vec::new(),
    }
}

/// コメントを取得できず、ゲート結果を判定できない場合の終了結果。
///
/// `done` は終了処理そのものを失敗させないため、エラーを JSON の
/// スキーマ外へ持ち出さず、通過とは判定しない結果を返す。
pub(crate) fn error_output() -> CheckOutput {
    CheckOutput {
        passes: false,
        blocking_threads: Vec::new(),
    }
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
            replies: thread.messages[1..]
                .iter()
                .map(|m| m.body.clone())
                .collect(),
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
