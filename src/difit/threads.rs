//! `mt difit threads --json` — 選択固定・読み取り専用の未 resolve スレッド読み取り。
//!
//! `.difit/difit-review.json` に記録された選択（base / target / baseMode）で
//! `/api/comments-json` を読み、未 resolve スレッドとゲート判定を JSON で返す。
//! サーバ状態・state ファイルのいずれも変更しない（read-only）。stale state の
//! 復旧も行わない（stale 復旧は `mt difit start` / `mt difit check` の責務）。
//! state 不在・選択キー未記録・サーバ同一性照合不能・サーバ不応答は明確な
//! エラーで非 0 exit し、無音で pass しない。
//!
//! このコマンドは review-diff ワークフロー（M2）の読み取り経路を、
//! difit 内部契約に依存する unpinned な `difit comment get` から、選択ピン留め
//! 契約（`check` と同一の CommentSelection）へ載せ替えるための公開 API である。
//! ゲート分類は Rust の `gate.rs`（`mt difit check` と同一実装）が行い、
//! ワークフロー側での再実装・写経を不要にする。
//!
//! ## 出力スキーマ（ワークフローとの契約）
//!
//! ```json
//! {
//!   "passes": false,
//!   "selection": {"base": "abc1234", "target": "def5678", "baseMode": "merge-base"},
//!   "selection_drift": {
//!     "detection": "detected",
//!     "expected": {"base": "abc1234", "target": "def5678", "baseMode": "merge-base"},
//!     "current": {"base": "9999999", "target": "def5678"}
//!   },
//!   "threads": [
//!     {
//!       "id": "<thread id>",
//!       "filePath": "src/foo.rs",
//!       "position": {"side": "new", "line": 12},
//!       "taxonomy": "issue",
//!       "blocking": true,
//!       "body": "<親メッセージ本文（原文）>",
//!       "author": "User",
//!       "replies": [{"author": null, "body": "<reply 本文（原文）>"}]
//!     }
//!   ],
//!   "blocking_threads": [
//!     {
//!       "id": "<thread id>",
//!       "file": "src/foo.rs",
//!       "line": 12,
//!       "taxonomy": "issue",
//!       "body": "<親メッセージ本文（原文）>",
//!       "replies": ["<reply 本文（原文）>"]
//!     }
//!   ]
//! }
//! ```
//!
//! - `passes` は未 resolve スレッドがすべてノンブロッキングのとき true
//! - `threads` は未 resolve スレッド全件（resolve 済みは difit 契約により現れない）
//! - `blocking_threads` は `mt difit check` の stdout と同一形状・同一分類
//! - `taxonomy` は `issue` / `question` / `context` / `human`。want はブロッキングに
//!   昇格した場合のみ `blocking: true` になる（分類規則は `gate.rs` が唯一の実装）
//! - `selection` は読み取りに使った固定選択（`baseMode` は direct のとき省略）
//! - `selection_drift` は difit サーバが現在返す選択と `selection` の比較結果
//!   （GET `/api/diff` のみ・read-only）。`detection` は `detected` / `none` /
//!   `unavailable` の三値で、`unavailable`（probe 失敗）は「ドリフトなし」と同じ
//!   `none` へ倒さない。ワークフローは `unavailable` を fail-closed に扱える。
//!   `detected` のとき difit UI での reply / resolve はゲートが読むセッションとは
//!   別のセッションへ向かう

use std::path::Path;

use anyhow::Context;
use serde::Serialize;

use super::check::{self, BlockingThread, taxonomy_label};
use super::client::{self, CommentSelection};
use super::gate::{self, Thread};
use super::shared;

/// `mt difit threads` のエントリポイント（`--json` 専用）。
pub fn threads() -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    let out = read_threads(&repo_root)?;
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

/// 指定リポジトリの選択固定済み・未 resolve スレッドを読み取る（read-only）。
///
/// テストから一時リポジトリを扱えるよう、リポジトリルートを引数に取る処理を分離する。
pub(crate) fn read_threads(repo_root: &Path) -> anyhow::Result<ThreadsOutput> {
    let Some(state) = shared::read_review_state(repo_root) else {
        anyhow::bail!(
            "アクティブな difit レビューセッションがありません。先に mt difit start を実行してください"
        );
    };

    // 選択キーがない state（選択固定前の旧 state）は、どのコメントセッションを
    // 読むべきか確定できない。無音 pass を避けるため fail-closed で止める。
    let selection = shared::require_selection(&state)?;

    // 記録された pid が記録 port の LISTEN であることを照合してから読む
    // （PID 再利用・記録 port で応答する別プロセスからの読み取りを避ける）。
    // サーバ死・照合不能はここでは復旧せず fail-closed にする（read-only）。
    shared::require_server_identity(&state)?;

    // ワークフローが使う読み取り経路でも選択ドリフトを検知して報告する
    // （GET /api/diff のみ・read-only。判定は固定選択で継続する）。
    let drift = check::detect_selection_drift(state.port, selection);
    check::warn_on_selection_drift(&drift);

    let response = client::fetch_comments(state.port, Some(selection))
        .context("選択固定で difit サーバから未 resolve スレッドを取得できませんでした")?;

    let passes = gate::gate_passes(&response.threads);
    let threads = response
        .threads
        .iter()
        .filter_map(ThreadView::from_thread)
        .collect();
    let blocking_threads = BlockingThread::blocking_from_threads(&response.threads);

    Ok(ThreadsOutput {
        passes,
        selection: selection.clone(),
        selection_drift: drift,
        threads,
        blocking_threads,
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct ThreadsOutput {
    passes: bool,
    selection: CommentSelection,
    /// difit サーバが現在返す選択と `selection` の比較結果（read-only の GET のみ）。
    selection_drift: check::SelectionDrift,
    threads: Vec<ThreadView>,
    blocking_threads: Vec<BlockingThread>,
}

/// 未 resolve スレッド 1 件の読み取りビュー。
#[derive(Debug, Serialize)]
struct ThreadView {
    id: String,
    #[serde(rename = "filePath")]
    file_path: String,
    position: serde_json::Value,
    taxonomy: String,
    blocking: bool,
    body: String,
    author: Option<String>,
    replies: Vec<ReplyView>,
}

/// スレッド内 reply 1 件の本文と投稿者。
#[derive(Debug, Serialize)]
struct ReplyView {
    author: Option<String>,
    body: String,
}

impl ThreadView {
    fn from_thread(thread: &Thread) -> Option<Self> {
        let parent = thread.messages.first()?;
        Some(Self {
            id: thread.id.clone(),
            file_path: thread.file_path.clone(),
            position: thread.position.clone(),
            taxonomy: taxonomy_label(gate::classify_message(parent)),
            blocking: gate::thread_blocks(thread),
            body: parent.body.clone(),
            author: parent.author.clone(),
            replies: thread.messages[1..]
                .iter()
                .map(|message| ReplyView {
                    author: message.author.clone(),
                    body: message.body.clone(),
                })
                .collect(),
        })
    }
}

#[cfg(test)]
#[path = "threads.test.rs"]
mod tests;
