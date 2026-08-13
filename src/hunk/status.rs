//! `mt hunk status` — セッション状態の診断表示。
//!
//! セッションの有無・hunk セッションの生存・適用済みコメント数を表示する。
//! stale state（hunk-review.json はあるがセッションを検出できない）では
//! 警告を表示するが、修復や削除は行わない（自己修復は `start` / `check` の責務）。
//! 終了コードは実行時エラーのみ非 0 で、通常は exit 0 を返す。

use std::path::Path;

use super::shared;

/// `mt hunk status` のエントリポイント。
pub fn status() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    print!("{}", render_status(&repo_root));
    Ok(())
}

/// セッション状態の表示文を作る。
///
/// 読み取り専用: `hunk-review.json` の参照と hunk セッションの検出のみを行い、
/// セッションの操作・状態ファイルの変更は一切行わない。
/// テストから一時リポジトリを扱えるよう、リポジトリルートを引数に取る。
fn render_status(repo_root: &Path) -> String {
    let Some(state) = shared::read_review_state(repo_root) else {
        return "hunk review session: none\n".to_string();
    };

    let mut out = String::new();
    if shared::find_session(repo_root).is_ok() {
        out.push_str("hunk review session: active\n");
    } else {
        out.push_str("hunk review session: stale\n");
        out.push_str(
            "  warning: 対応する hunk セッションが見つかりません。復旧は mt hunk start / mt hunk check が行います\n",
        );
    }
    out.push_str(&format!("  applied comments: {}\n", state.comments.len()));
    out
}

#[cfg(test)]
#[path = "status.test.rs"]
mod tests;
