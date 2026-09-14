//! `mt difit resolve` — 修正済み AI スレッドの選択固定 resolve。
//!
//! executor / agents の resolve 経路を `difit comment resolve --port` の直叩きから
//! 置き換え、同一性検証と選択固定を 1 コマンドに集約する。`difit comment resolve`
//! は state ファイル由来の port へ無検証で DELETE を送るため、clone 先に仕込まれた
//! 細工や PID 再利用で state の port が別セッション（別プロジェクトの difit を含む）
//! を指すと、無関係なスレッドを不可逆に削除し得る（ADR-0026 の同一性契約）。
//!
//! 実行順（いずれかが失敗したら resolve せず、stdout に JSON を出さず非 0 exit）:
//!
//! 1. state 読み取り（`read_review_state` の fail-closed 検証: symlink 拒否・
//!    `pid <= 0` / `port == 0` 拒否・state 不在）
//! 2. 選択キー必須（未記録はどのセッションを resolve すべきか確定できない）
//! 3. [`shared::require_server_identity`]（記録 pid が記録 port の LISTEN）
//! 4. 選択固定の取得（difit 応答確認を兼ねる）で対象スレッドの存在と親 author を
//!    確認。親メッセージが人間（`User`）なら拒否する
//!    （人間コメントは人間が difit UI で resolve する）
//! 5. 選択固定の `DELETE /api/comments/<threadId>` で resolve
//!
//! 出力契約:
//! - 成功: `{"resolved":true,"threadId":"<id>"}` を stdout へ出して exit 0
//! - 失敗: 理由を stderr へ出して非 0 exit（state 不在 / 選択未記録 / 同一性未確認 /
//!   対象が未 resolve スレッドにない / 人間コメント / HTTP 失敗）

use std::path::Path;

use anyhow::{Context, bail};
use serde::Serialize;

use super::client;
use super::gate;
use super::shared;

/// `mt difit resolve` のエントリポイント。
pub fn resolve(thread_id: String) -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    let output = resolve_in(&repo_root, &thread_id)?;
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

/// `mt difit resolve` の成功出力。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveOutput {
    resolved: bool,
    thread_id: String,
}

/// 指定リポジトリの選択固定セッションから 1 スレッドを resolve する。
///
/// テストから一時リポジトリを扱えるよう、リポジトリルートを引数に取る処理を分離する。
pub(crate) fn resolve_in(repo_root: &Path, thread_id: &str) -> anyhow::Result<ResolveOutput> {
    let Some(state) = shared::read_review_state(repo_root) else {
        bail!(
            "アクティブな difit レビューセッションがありません。先に mt difit start を実行してください"
        );
    };
    let selection = shared::require_selection(&state)?;

    // state ファイル由来の port へ無検証で DELETE を送らない。記録 pid が記録 port の
    // LISTEN であることを OS 情報で照合できなければ resolve しない。
    shared::require_server_identity(&state)?;

    // 対象を選択固定で取得し、存在と author を確認してから DELETE する。
    // 取得を省いて ID だけ渡すと、存在しない ID や別セッションのスレッドにも
    // DELETE が飛ぶため、取得→判定を必須にする。
    let response = client::fetch_comments(state.port, Some(selection))
        .context("選択固定で difit サーバから未 resolve スレッドを取得できませんでした")?;
    let Some(thread) = response
        .threads
        .iter()
        .find(|thread| thread.id == thread_id)
    else {
        bail!(
            "スレッド {thread_id} は固定した選択セッションの未 resolve スレッドにありません\
             （resolve 済みか、別の diff 選択のスレッドです）。\
             mt difit threads --json で未 resolve スレッドを確認してください"
        );
    };

    // 人間コメント（親メッセージの author が User）は人間が resolve する。
    // AI 指摘への人間 reply は修正後にエージェントが resolve してよい（親 author のみ見る）。
    if gate::thread_parent_is_human(thread) {
        bail!(
            "スレッド {thread_id} は人間のコメント（author: User）のため resolve しません。\
             人間コメントは人間が difit UI で resolve してください"
        );
    }

    client::resolve_comment(state.port, Some(selection), thread_id)
        .with_context(|| format!("選択固定でスレッド {thread_id} を resolve できませんでした"))?;

    Ok(ResolveOutput {
        resolved: true,
        thread_id: thread_id.to_string(),
    })
}

#[cfg(test)]
#[path = "resolve.test.rs"]
mod tests;
