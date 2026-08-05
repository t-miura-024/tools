//! `mt difit status` — セッション状態の診断表示。
//!
//! 完了条件 4: セッションの有無・サーバ生存・ポート・difit 起動引数・
//! 注入コメント数を表示する。stale state（サーバ死）では警告を表示するが、
//! 修復や kill は行わない（自己修復は `start` / `check` の責務）。
//! 終了コードは実行時エラーのみ非 0 で、通常は exit 0 を返す。

use std::path::Path;

use super::shared;

/// `mt difit status` のエントリポイント。
pub fn status() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    print!("{}", render_status(&repo_root));
    Ok(())
}

/// セッション状態の表示文を作る。
///
/// 読み取り専用: `difit-review.json` の参照とプロセス生存確認のみを行い、
/// サーバの起動・kill・状態ファイルの変更は一切行わない。
/// テストから一時リポジトリを扱えるよう、リポジトリルートを引数に取る。
fn render_status(repo_root: &Path) -> String {
    let Some(state) = shared::read_review_state(repo_root) else {
        return "difit review session: none\n".to_string();
    };

    let alive = shared::is_process_alive(state.pid);
    let args = if state.difit_args.is_empty() {
        "(none)".to_string()
    } else {
        state.difit_args.join(" ")
    };

    let mut out = String::new();
    if alive {
        out.push_str("difit review session: active\n");
    } else {
        out.push_str("difit review session: stale\n");
        out.push_str(
            "  warning: difit サーバのプロセスが死んでいます。復旧は mt difit start / mt difit check が行います\n",
        );
    }
    out.push_str(&format!(
        "  server: http://localhost:{} (pid {}, {})\n",
        state.port,
        state.pid,
        if alive { "running" } else { "not running" },
    ));
    out.push_str(&format!("  difit args: {args}\n"));
    out.push_str(&format!("  injected comments: {}\n", state.comments.len()));
    out
}

#[cfg(test)]
#[path = "status.test.rs"]
mod tests;
