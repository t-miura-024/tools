//! `mt difit done` — difit レビューセッションの終了。
//!
//! `check` と同じゲート結果を出力するが、通過・ブロックに関係なく
//! サーバと状態ファイルを片付け、exit 0 で終了する。

use std::path::Path;

use super::{check, shared};

/// `mt difit done` のエントリポイント。
pub fn done() -> anyhow::Result<()> {
    let output = match shared::git_repo_root() {
        Ok(repo_root) => match done_in(&repo_root) {
            Ok(output) => output,
            Err(error) => {
                // done は終了コマンドなので、判定処理の想定外エラーでも
                // JSON 出力と exit 0 を維持する。
                eprintln!("mt difit done: {error:#}");
                check::error_output()
            }
        },
        Err(error) => {
            eprintln!("mt difit done: {error:#}");
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
    Ok(done_in_with_details(repo_root).output)
}

struct DoneDetails {
    output: check::CheckOutput,
    #[cfg(test)]
    cleanup_pid: Option<i32>,
}

fn done_in_with_details(repo_root: &Path) -> DoneDetails {
    let Some(state) = shared::read_review_state(repo_root) else {
        shared::delete_review_state(repo_root);
        return DoneDetails {
            output: check::empty_output(),
            #[cfg(test)]
            cleanup_pid: None,
        };
    };

    // stale state の場合も check と同様に保存済みコメントで復旧してから
    // 現在のゲート結果を取得する。ただし done では復旧したサーバも必ず停止する。
    let mut server_pid = state.pid;
    let response = if shared::is_process_alive(state.pid) {
        shared::fetch_comments(state.port)
    } else {
        match shared::spawn_difit_server(repo_root, &state.difit_args, &state.comments) {
            Ok(bg) => {
                server_pid = bg.pid;
                let new_state = shared::ReviewState {
                    port: bg.port,
                    pid: bg.pid,
                    comments: state.comments,
                    difit_args: state.difit_args,
                };
                match shared::write_review_state(repo_root, &new_state) {
                    Ok(()) => shared::fetch_comments(bg.port),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    };

    // コメント取得や stale 復旧に失敗した場合も、終了コマンドとしての
    // cleanup は行う。エラーは stderr に記録し、stdout には常にゲート結果と
    // 同じ JSON スキーマを出力する。
    shared::kill_server(server_pid);
    shared::delete_review_state(repo_root);

    let output = match response {
        Ok(response) => check::output_for_response(&response),
        Err(error) => {
            eprintln!("mt difit done: {error:#}");
            check::error_output()
        }
    };

    DoneDetails {
        output,
        #[cfg(test)]
        cleanup_pid: Some(server_pid),
    }
}

#[cfg(test)]
fn done_in_with_cleanup_pid(repo_root: &Path) -> anyhow::Result<(check::CheckOutput, Option<i32>)> {
    let details = done_in_with_details(repo_root);
    Ok((details.output, details.cleanup_pid))
}

#[cfg(test)]
#[path = "done.test.rs"]
mod tests;
