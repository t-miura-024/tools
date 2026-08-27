//! `mt hunk check` — ゲート判定。
//!
//! 完了条件 3: 未解決 AI コメント残存でブロック、AI コメントの rm = 解決、
//! 人間コメント残存 = ブロック、want はノンブロッキング。
//! stale state（hunk-review.json はあるがセッションを検出できない）を自己修復する。

use serde::Serialize;

use super::shared::{self, HunkComment};

/// `mt hunk check` のエントリポイント。
///
/// ゲート通過 → `Ok(())`（exit 0）、ブロック → `std::process::exit(1)`。
pub fn check() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;

    let _state = match shared::read_review_state(&repo_root) {
        Some(s) => s,
        None => {
            anyhow::bail!(
                "アクティブな hunk セッションが見つかりません。リポジトリで hunk diff / hunk show を起動してください"
            );
        }
    };

    // --- コメント取得（stale state は自己修復）---
    // セッションが検出できない（TUI が終了した等）場合、コメントも消えているため
    // ブロック理由は存在しない。状態ファイルを削除して通過として扱う。
    let comments = match shared::find_session(&repo_root) {
        Ok(_) => shared::fetch_comments(&repo_root)?,
        Err(_) => {
            eprintln!(
                "mt hunk check: 対応する hunk セッションが見つかりません。stale 状態を修復しました"
            );
            shared::delete_review_state(&repo_root);
            Vec::new()
        }
    };

    let out = output_for_comments(&comments);

    if out.passes {
        // 削除は `mt hunk done` に一本化する。`check` での削除はワークフロー側の
        // 再検証（`mt hunk check` の二度実行）が「状態なし」でJSONを返せず
        // `goto execute_work` ループに入る原因になるため、ここでは削除しない。
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

/// コメント一覧から、`check` / `done` 共通のゲート出力を作る。
pub(crate) fn output_for_comments(comments: &[HunkComment]) -> CheckOutput {
    let passes = shared::gate_passes(comments);
    let blocking_threads = if passes {
        Vec::new()
    } else {
        comments
            .iter()
            .filter_map(BlockingThread::from_comment)
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
    line: Option<u64>,
    taxonomy: String,
    body: String,
    replies: Vec<String>,
}

impl BlockingThread {
    fn from_comment(comment: &HunkComment) -> Option<Self> {
        // 人間コメントは常にブロッキング
        if comment.source == "user" {
            return Some(Self {
                id: comment.note_id.clone(),
                file: comment.file_path.clone(),
                line: comment
                    .new_range
                    .or(comment.old_range)
                    .map(|range| range[0]),
                taxonomy: "human".to_string(),
                body: comment.body.clone(),
                replies: Vec::new(),
            });
        }

        // AI コメントは want 指摘のみノンブロッキング
        if shared::is_want(&comment.body) {
            return None;
        }
        let taxonomy = if comment.body.trim_start().starts_with("[issue]") {
            "issue"
        } else {
            "question"
        };
        Some(Self {
            id: comment.note_id.clone(),
            file: comment.file_path.clone(),
            line: comment
                .new_range
                .or(comment.old_range)
                .map(|range| range[0]),
            taxonomy: taxonomy.to_string(),
            body: comment.body.clone(),
            replies: Vec::new(),
        })
    }
}

#[cfg(test)]
#[path = "check.test.rs"]
mod tests;
