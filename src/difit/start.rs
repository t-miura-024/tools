//! `mt difit start` — difit サーバの起動とコメント注入。
//!
//! 完了条件 1: stdout に `{"port": N, "url": "http://localhost:N"}` を出力。
//! 完了条件 3: `.difit/` を idempotent に作成し `difit-review.json` を管理。
//! 完了条件 4: stdin 空の場合、保存済みコメントで再注入（クラッシュ復旧）。
//! 完了条件 5: stale 状態を自己修復（旧サーバ kill → 再起動）。

use std::io::{IsTerminal, Read};

use anyhow::Context;

use super::shared::{self, ReviewState};

/// `mt difit start` のエントリポイント。
pub fn start(difit_args: Vec<String>) -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    shared::ensure_difit_dir(&repo_root)?;

    // --- 旧サーバの処理（ゾンビ防止 & stale 自己修復）---
    let old_state = shared::read_review_state(&repo_root);

    // 旧サーバが生存していれば kill 前に現在コメントを取得する。
    // resolve 済みスレッドは comment get から消えるため、
    // 再注入時に正しく解決済み扱いになる（方針 6）。
    let saved_comments = match old_state {
        Some(ref old) if shared::is_process_alive(old.pid) => {
            let fetched = shared::fetch_comments(old.port)
                .ok()
                .map(|resp| shared::threads_to_import_comments(&resp.threads))
                .unwrap_or_else(|| old.comments.clone());
            shared::kill_server(old.pid);
            shared::delete_review_state(&repo_root);
            fetched
        }
        Some(ref old) => {
            // stale（サーバ死）→ 保存済みコメントで復旧
            let comments = old.comments.clone();
            shared::delete_review_state(&repo_root);
            comments
        }
        None => Vec::new(),
    };

    // --- コメントの決定: stdin 優先、空なら保存済みで復旧 ---
    let comments = read_stdin_comments()?.unwrap_or(saved_comments);

    // --- difit サーバ起動 ---
    let bg = shared::spawn_difit_server(&repo_root, &difit_args, &comments)?;

    // --- 状態保存 ---
    let state = ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments,
        difit_args,
    };
    shared::write_review_state(&repo_root, &state)?;

    // --- stdout に JSON 出力（完了条件 1）---
    let out = serde_json::json!({
        "port": bg.port,
        "url": format!("http://localhost:{}", bg.port),
    });
    println!("{}", out);

    Ok(())
}

/// stdin からコメント JSON を読み込む。
///
/// - stdin が TTY（パイプなし）→ `None`
/// - stdin が空 → `None`
/// - JSON 配列 → そのまま
/// - JSON オブジェクト → 1 要素の配列にラップ
fn read_stdin_comments() -> anyhow::Result<Option<Vec<serde_json::Value>>> {
    if std::io::stdin().is_terminal() {
        return Ok(None);
    }

    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("stdin の読み込みに失敗しました")?;

    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value: serde_json::Value =
        serde_json::from_str(trimmed).context("stdin の JSON パースに失敗しました")?;

    let comments = match value {
        serde_json::Value::Array(arr) => arr,
        other => vec![other],
    };

    Ok(Some(comments))
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
