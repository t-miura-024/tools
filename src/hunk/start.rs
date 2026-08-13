//! `mt hunk start` — アクティブな hunk セッションへのコメント適用。
//!
//! 完了条件 1: stdout に `{"session": <id>, "comments": N}` を出力。
//! 完了条件 3: stdin のコメントを hunk の `comment apply` 形式に直通させる。
//! ファイルレベル指摘（行指定なし）は newLine: 1 に合成する（方針 3）。
//! stale state（hunk-review.json はあるがセッションを検出できない）は自己修復する。

use std::io::{IsTerminal, Read};

use anyhow::Context;

use super::shared::{self, ReviewState};

/// `mt hunk start` のエントリポイント。
pub fn start() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    shared::ensure_hunk_dir(&repo_root)?;

    // --- セッション検出（方針 2）---
    // セッションが検出できない場合（stale state を含む）は状態を削除して
    // クリーンアップし、ユーザーに hunk の起動を促す。
    let session = match shared::find_session(&repo_root) {
        Ok(session) => session,
        Err(error) => {
            shared::delete_review_state(&repo_root);
            return Err(error);
        }
    };

    // --- コメントの決定: stdin が TTY または空ならコメントなし ---
    let comments = read_stdin_comments()?.unwrap_or_default();

    // --- ファイルレベル指摘の newLine 合成（方針 3, 完了条件 1, 2）---
    // hunk の comment apply は行指定（newLine / oldLine）を必須とする。
    // 行指定なし（ファイルレベル）のエントリは newLine: 1 に合成する。
    let comments = synthesize_missing_lines(comments);

    // --- コメント適用 ---
    if !comments.is_empty() {
        shared::apply_comments(&repo_root, &comments)?;
    }

    // --- 状態保存（stale state 検出用）---
    shared::write_review_state(
        &repo_root,
        &ReviewState {
            comments: comments.clone(),
        },
    )?;

    // --- stdout に JSON 出力（完了条件 1）---
    let out = serde_json::json!({
        "session": session.session_id,
        "comments": comments.len(),
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

/// 行指定（newLine / oldLine）を持たないコメントエントリに `newLine: 1` を合成する。
///
/// hunk の comment apply は行指定を必須としており、欠落時はバリデーションエラーになる。
/// 行指定なし（ファイルレベル）のコメントエントリを apply に渡す前に newLine: 1 に
/// 正規化する（方針 3）。
///
/// 合成は newLine / oldLine の**どちらも持たない**エントリにのみ適用される。
/// 適用後に再適用しても結果は変わらない（冪等）。
fn synthesize_missing_lines(comments: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    comments
        .into_iter()
        .map(|entry| match entry {
            serde_json::Value::Object(mut obj)
                if !obj.contains_key("newLine") && !obj.contains_key("oldLine") =>
            {
                obj.insert("newLine".to_string(), serde_json::json!(1));
                serde_json::Value::Object(obj)
            }
            other => other,
        })
        .collect()
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
