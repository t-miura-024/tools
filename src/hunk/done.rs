//! `mt hunk done` — hunk レビューセッションの終了。
//!
//! `check` と同じゲート結果を出力するが、通過・ブロックに関係なく
//! 状態ファイル（hunk-review.json）を片付け、exit 0 で終了する。
//! hunk TUI セッション自体はユーザーのターミナルに属するため終了しない。

use std::path::Path;

use super::{check, shared};

/// `mt hunk done` のエントリポイント。
pub fn done() -> anyhow::Result<()> {
    let output = match shared::git_repo_root() {
        Ok(repo_root) => match done_in(&repo_root) {
            Ok(output) => output,
            Err(error) => {
                // done は終了コマンドなので、判定処理の想定外エラーでも
                // JSON 出力と exit 0 を維持する。
                eprintln!("mt hunk done: {error:#}");
                check::error_output()
            }
        },
        Err(error) => {
            eprintln!("mt hunk done: {error:#}");
            check::error_output()
        }
    };
    // CheckOutput の Serialize は失敗しないが、終了コマンドの契約を守るため
    // シリアライズ失敗時もスキーマを崩さず exit 0 を維持する。
    let json = serde_json::to_string(&output)
        .unwrap_or_else(|_| r#"{"passes":false,"blocking_threads":[]}"#.to_string());
    println!("{json}");
    Ok(())
}

/// 指定したリポジトリのレビューセッションを終了する。
///
/// テストから一時リポジトリを扱えるよう、リポジトリルートを引数に取る
/// 処理を分離している。状態が存在しない場合は、すでに終了済みとして
/// 空のゲート結果を返す（`done` は冪等な終了コマンド）。
fn done_in(repo_root: &Path) -> anyhow::Result<check::CheckOutput> {
    let output = done_in_with_details(repo_root).output;

    // セッション判定の成否にかかわらず、状態ファイルは必ず削除する。
    shared::delete_review_state(repo_root);

    Ok(output)
}

struct DoneDetails {
    output: check::CheckOutput,
}

fn done_in_with_details(repo_root: &Path) -> DoneDetails {
    let Some(_state) = shared::read_review_state(repo_root) else {
        return DoneDetails {
            output: check::empty_output(),
        };
    };

    // stale state（セッションなし）の場合もコメントは消えているため
    // 通過として扱い、状態ファイルは done_in が削除する。
    let output = match shared::find_session(repo_root) {
        Ok(_) => match shared::fetch_comments(repo_root) {
            Ok(comments) => check::output_for_comments(&comments),
            Err(error) => {
                eprintln!("mt hunk done: {error:#}");
                check::error_output()
            }
        },
        Err(_) => {
            eprintln!(
                "mt hunk done: 対応する hunk セッションが見つかりません。stale 状態を修復しました"
            );
            check::empty_output()
        }
    };

    DoneDetails { output }
}

#[cfg(test)]
#[path = "done.test.rs"]
mod tests;
