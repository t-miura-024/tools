//! `mt difit done` — difit レビューセッションの終了。
//!
//! `check` と同じゲート結果を出力するが、通過・ブロックに関係なく
//! サーバと状態ファイルを片付け、exit 0 で終了する。
//! 後始末は `check` の通過時と共用する `shared::close_session` に一本化する。
//!
//! サーバ同一性を確認できない場合（復旧失敗、記録 pid が記録 port を LISTEN
//! していることの OS 照合失敗など）は kill を行わず、状態削除のみ行う。
//! 無関係プロセスへ SIGTERM を送らないことを優先する。

use std::path::Path;

use super::{check, client, shared};

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
        return DoneDetails {
            output: check::empty_output(),
            #[cfg(test)]
            cleanup_pid: None,
        };
    };

    // stale state の場合も check と同様に保存済みコメントで復旧してから
    // 現在のゲート結果を取得する。
    //
    // 選択キー未記録の旧 state はサーバ可変の選択に依存する unpinned 取得に
    // なるが、done はゲート結果にかかわらず終了する明示的な破棄経路のため
    // fail-closed にしない（判定不能時は passes=false を返す）。
    let (cleanup, output) = match shared::ensure_server_running(repo_root, state.clone()) {
        Ok(recovered) => {
            let output = match client::fetch_comments(recovered.port, recovered.selection.as_ref())
            {
                Ok(response) => check::output_for_response(&response),
                Err(error) => {
                    eprintln!("mt difit done: {error:#}");
                    check::error_output()
                }
            };
            (Some((recovered.pid, recovered.port)), output)
        }
        Err(error) => {
            // 復旧失敗 = 記録された pid が difit サーバであることを確認できない。
            // 誤って無関係プロセス（PID 再利用等）を kill しないため対象にしない。
            eprintln!("mt difit done: {error:#}");
            (None, check::error_output())
        }
    };

    // コメント取得や stale 復旧に失敗した場合も、終了コマンドとしての
    // cleanup は行う。エラーは stderr に記録し、stdout には常にゲート結果と
    // 同じ JSON スキーマを出力する。
    shared::close_session(repo_root, cleanup);

    DoneDetails {
        output,
        #[cfg(test)]
        cleanup_pid: cleanup.map(|(pid, _)| pid),
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
